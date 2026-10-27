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

import * as fs from "fs";
import * as http from "http";
import { Cli, StartupDisplay } from "@activeledger/activeoptions";
import { NODE_STEPS } from "./node";

/**
 * Process control for `activehybrid`: the PID file, the state file a detached
 * node reports progress through, and the requests the CLI makes of a running
 * node. Kept apart from index.ts so it can be tested.
 */

export const PID_FILE = "./.activehybrid.pid";
export const STATE_FILE = "./.activehybrid.state";

/** What the node tells the launching terminal while it starts */
export interface StateReport {
  step?: string;
  event?: "begin" | "done" | "fail";
  detail?: string;
  lag?: number;
  cursor?: string;
  ready?: boolean;
  error?: string;
}

/** Atomic: the reader never sees half a file */
export function writeState(file: string, report: StateReport): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, file);
}

export function readState(file: string): StateReport | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but is not ours
    return e?.code === "EPERM";
  }
};

export function readPid(file: string = PID_FILE): number | undefined {
  try {
    const pid = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The running node's pid, clearing a stale file */
export function runningPid(file: string = PID_FILE): number | undefined {
  const pid = readPid(file);
  if (pid && alive(pid)) return pid;
  if (pid) fs.rmSync(file, { force: true });
  return undefined;
}

/**
 * Take the PID file for this process, refusing when a live node holds it.
 * Written exclusively, so two starts at once cannot both win.
 */
export function claimPid(pid: number = process.pid, file: string = PID_FILE): boolean {
  if (runningPid(file) && readPid(file) !== pid) return false;
  try {
    fs.writeFileSync(file, String(pid), { flag: "w" });
    return true;
  } catch {
    return false;
  }
}

export const releasePid = (pid: number = process.pid, file: string = PID_FILE): void => {
  if (readPid(file) === pid) fs.rmSync(file, { force: true });
};

export async function waitForExit(pid: number, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (alive(pid)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** `stop`: SIGTERM the node and wait for it to go. Exit 0 stopped (or not running), 1 if it would not exit. */
export async function stopNode(
  seconds: number,
  out: { log(t: string): void; error(t: string): void },
  json: boolean,
  file: string = PID_FILE
): Promise<number> {
  const pid = runningPid(file);
  if (!pid) {
    out.log(json ? JSON.stringify({ stopped: false, running: false }) : "not running");
    return Cli.ExitCode.OK;
  }
  process.kill(pid, "SIGTERM");
  if (!(await waitForExit(pid, seconds))) {
    out.error(`process ${pid} did not exit within ${seconds}s`);
    return Cli.ExitCode.FAIL;
  }
  fs.rmSync(file, { force: true });
  out.log(json ? JSON.stringify({ stopped: true, pid }) : `stopped ${pid}`);
  return Cli.ExitCode.OK;
}

/** One request of the running node */
export function nodeRequest(
  host: string,
  port: number,
  method: string,
  path: string,
  token?: string,
  timeoutMs = 10000
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method, path, timeout: timeoutMs, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            reject(new Error(`not JSON from ${path}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** `status`: Exit 0 ready (and within --max-lag), 2 not ready, lagging or not running */
export async function statusOf(
  host: string,
  port: number,
  token: string | undefined,
  maxLag: number | undefined
): Promise<{ code: number; body: any }> {
  let res;
  try {
    res = await nodeRequest(host, port, "GET", "/health", token);
  } catch {
    return { code: Cli.ExitCode.STATE, body: { ready: false, reason: "not running" } };
  }
  const body = res.body ?? {};
  const lagging =
    maxLag !== undefined && (body.lagSeconds === null || body.lagSeconds === undefined || body.lagSeconds > maxLag);
  return {
    code: res.status === 200 && body.ready && !lagging ? Cli.ExitCode.OK : Cli.ExitCode.STATE,
    body: lagging && body.ready ? { ...body, reason: "lagging" } : body,
  };
}

/**
 * Drive a start-up display from a node's state file: the launching terminal
 * shows the chain while a detached node starts. Resolves 0 when ready, 1 on
 * failure or when the node dies first.
 */
export async function followStart(
  display: StartupDisplay,
  pid: number,
  stateFile: string,
  timeoutMs = 10 * 60 * 1000
): Promise<number> {
  const seen = new Set<string>();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = readState(stateFile);
    if (s?.step && s.event) {
      const key = `${s.step}:${s.event}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (s.event === "begin") display.begin(s.step);
        else if (s.event === "done") display.done(s.step);
        else {
          display.fail(s.detail ?? s.error ?? "failed", s.step);
          return Cli.ExitCode.FAIL;
        }
      }
      if (s.step === "catching up" && s.event === "begin" && s.lag !== undefined) {
        display.catchUp(s.lag, s.cursor ?? "");
      }
    }
    if (s?.step === "catching up" && s.lag !== undefined && !seen.has("catching up:done")) {
      display.catchUp(s.lag, s.cursor ?? "");
    }
    if (s?.ready) {
      display.finish();
      return Cli.ExitCode.OK;
    }
    if (!alive(pid)) {
      display.fail(s?.error ?? "the node exited during start-up");
      return Cli.ExitCode.FAIL;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  display.fail("timed out waiting for the node to become ready");
  return Cli.ExitCode.FAIL;
}

export { NODE_STEPS };
