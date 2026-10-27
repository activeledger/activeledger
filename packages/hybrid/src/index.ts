#!/usr/bin/env node

/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as child from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { Cli, StartupDisplay, isManaged } from "@activeledger/activeoptions";
import { checkConfig, consoleOut, init, peers, pin, register, retire, token, update } from "./commands";
import { ConfigError, loadConfig, mergeFlags } from "./config";
import { NODE_STEPS, HybridNode } from "./node";
import { BootstrapError } from "./bootstrap";
import { hybridProgram } from "./program";
import {
  PID_FILE,
  STATE_FILE,
  claimPid,
  followStart,
  nodeRequest,
  releasePid,
  runningPid,
  statusOf,
  stopNode,
  writeState,
} from "./run";

const version: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
).version;

const CHILD = "ACTIVEHYBRID_CHILD";

const configFile = (flags: Record<string, any>) => String(flags.config ?? "./hybrid.json");
const identityFile = (flags: Record<string, any>) => String(flags.identity ?? "./.identity");
const dataDir = (flags: Record<string, any>) => String(flags["data-dir"] ?? "./data");

/** The address to reach this node on: a wildcard bind is reached on loopback */
const localAddress = (bind: string) => (bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind);

const load = (flags: Record<string, any>) => mergeFlags(loadConfig(configFile(flags)), flags);

function printConfigError(e: unknown, json: boolean): number {
  const reasons = e instanceof ConfigError ? e.errors : [(e as Error).message];
  console.error(json ? JSON.stringify({ error: reasons }) : reasons.join("\n"));
  return Cli.ExitCode.FAIL;
}

/** Run the node in this process until it is told to stop */
async function runNode(flags: Record<string, any>, display: StartupDisplay | undefined, report: boolean): Promise<number> {
  let config;
  try {
    config = load(flags);
  } catch (e) {
    display?.begin("config");
    display?.fail((e as Error).message, "config");
    if (report) writeState(STATE_FILE, { step: "config", event: "fail", detail: (e as Error).message, error: (e as Error).message });
    return printConfigError(e, !!flags.json);
  }
  if (!claimPid()) {
    const msg = `already running (pid ${runningPid()})`;
    console.error(msg);
    if (report) writeState(STATE_FILE, { error: msg });
    return Cli.ExitCode.FAIL;
  }

  let lag: number | undefined;
  let cursor = "";
  const node = new HybridNode({
    config,
    dataDir: dataDir(flags),
    identityPath: identityFile(flags),
    version,
    onStep: (step, event, detail) => {
      if (event === "begin") display?.begin(step);
      else if (event === "done") display?.done(step);
      else display?.fail(detail ?? "failed", step);
      if (report) writeState(STATE_FILE, { step, event, detail, lag, cursor });
    },
    onProgress: (l, c) => {
      lag = l;
      cursor = c;
      display?.catchUp(l, c);
      if (report) writeState(STATE_FILE, { step: "catching up", event: "begin", lag: l, cursor: c });
    },
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await node.stop();
    releasePid();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await node.start();
  } catch (e) {
    const message = (e as Error).message;
    if (report) writeState(STATE_FILE, { error: message });
    if (!display) console.error(message);
    await node.stop().catch(() => undefined);
    releasePid();
    return e instanceof BootstrapError && e.refused ? Cli.ExitCode.STATE : Cli.ExitCode.FAIL;
  }

  display?.finish();
  if (report) writeState(STATE_FILE, { ready: node.state.ready, step: "ready", event: "done" });
  ActiveLogger.sink = undefined;
  // Stay up: the server and the feed keep the process alive
  return -1;
}

async function start(flags: Record<string, any>): Promise<number> {
  const json = !!flags.json;
  const env = { isTTY: !!process.stdout.isTTY, noColor: !!process.env.NO_COLOR, random: Math.random };
  const program = hybridProgram(version);

  if (process.env[CHILD]) {
    // The detached node: no display of its own, plain lines go to its log
    ActiveLogger.sink = undefined;
    return runNode(flags, undefined, true);
  }

  if (runningPid()) {
    console.error(`already running (pid ${runningPid()})`);
    return Cli.ExitCode.FAIL;
  }

  const display = new StartupDisplay(program, NODE_STEPS, {
    json,
    quiet: !!flags.quiet,
    managed: isManaged(),
    env,
  });
  ActiveLogger.sink = (line) => display.log(line);

  if (flags.foreground) {
    const code = await runNode(flags, display, false);
    return code;
  }

  // Detach: the node runs on without this terminal, and this terminal shows
  // its start-up until it reports ready
  fs.rmSync(STATE_FILE, { force: true });
  const log = fs.openSync("./activehybrid.log", "a");
  const argv = process.argv.slice(2).filter((a) => a !== "start");
  const proc = child.spawn(process.execPath, [process.argv[1], "start", "--foreground", ...argv.filter((a) => a !== "--foreground")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, [CHILD]: "1", NO_COLOR: "1" },
  });
  proc.unref();
  const code = await followStart(display, proc.pid as number, STATE_FILE);
  ActiveLogger.sink = undefined;
  return code;
}

async function main(): Promise<number> {
  const cli = Cli.runCli(hybridProgram(version), process.argv.slice(2));
  if (cli.exit !== undefined) return cli.exit;
  const flags = cli.flags as Record<string, any>;
  const json = !!flags.json;
  const ctx = { flags, out: consoleOut };

  switch (cli.command) {
    case "init":
      return init(ctx);
    case "token":
      return token(ctx);
    case "check-config":
      return checkConfig(ctx);
    case "register":
      return register(ctx);
    case "update":
      return update(ctx);
    case "retire":
      return retire(ctx);
    case "peers":
      return peers(ctx);
    case "pin":
      return pin(ctx);
    case "stop":
      return stopNode(Number(flags.timeout) || 30, consoleOut, json);
    case "restart": {
      const code = await stopNode(Number(flags.timeout) || 30, consoleOut, json);
      return code === Cli.ExitCode.OK ? start(flags) : code;
    }
    case "start":
      return start(flags);
    default: {
      // status, divergences, prune ask the running node
      let config;
      try {
        config = load(flags);
      } catch (e) {
        return printConfigError(e, json);
      }
      const host = localAddress(config.bind);
      if (cli.command === "status") {
        const maxLag = flags["max-lag"] !== undefined ? Number(flags["max-lag"]) : undefined;
        const { code, body } = await statusOf(host, config.port, config.token, maxLag);
        console.log(
          json
            ? JSON.stringify(body)
            : body.ready
            ? `ready  lag ${body.lagSeconds ?? "?"}s  cursor ${body.cursor || "-"}${code ? "  (lagging)" : ""}`
            : `not ready: ${body.reason ?? "unknown"}`
        );
        return code;
      }
      try {
        const res =
          cli.command === "divergences"
            ? await nodeRequest(host, config.port, "GET", `/divergences${flags.since ? `?since=${encodeURIComponent(String(flags.since))}` : ""}`, config.token)
            : await nodeRequest(host, config.port, "POST", `/prune${flags["dry-run"] ? "?dryRun=true" : ""}`, config.token);
        if (res.status !== 200) {
          console.error(res.body?.error ?? `HTTP ${res.status}`);
          return Cli.ExitCode.FAIL;
        }
        if (json) console.log(JSON.stringify(res.body));
        else if (cli.command === "divergences") {
          console.log(
            res.body.length
              ? res.body.map((d: any) => `${d.at}  ${d.kind}  ${d.umid}`).join("\n")
              : "no divergences"
          );
        } else {
          const r = res.body;
          console.log(`${r.dryRun ? "would prune" : "pruned"} ${r.umids.pruned} umid docs and ${r.events.pruned} events`);
        }
        return Cli.ExitCode.OK;
      } catch (e) {
        console.error(`could not reach the node: ${(e as Error).message}`);
        return Cli.ExitCode.STATE;
      }
    }
  }
}

main().then(
  (code) => {
    // -1: a running node, which keeps the process alive
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error((e as Error).message);
    process.exit(Cli.ExitCode.FAIL);
  }
);
