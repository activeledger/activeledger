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
import { ActiveOptions, ActiveRequest, Cli } from "@activeledger/activeoptions";
import {
  buildChange,
  HybridChange,
  keyArgument,
  signChange,
  signers,
  submitChange,
} from "./hybridChange";

/**
 * `activeledger hybrid list|feeds|ban|unban`. These ask the running node over
 * loopback, because the registry, the connected feeds and the ban list live
 * in its memory.
 */
const base = (): string => {
  const flagHost = ActiveOptions.get<string>("host", "");
  const flagPort = ActiveOptions.get<string>("port", "");
  if (flagHost && flagPort) return `http://${flagHost}:${flagPort}`;
  const file = ActiveOptions.get<string>("config", "./config.json");
  const host = JSON.parse(fs.readFileSync(file, "utf8")).host as string;
  return `http://${flagHost ? `${flagHost}:${host.split(":").pop()}` : host}`;
};

const sendChange = async (
  request: any,
  show: (data: unknown, text: string) => void,
  out: { error(t: string): void }
): Promise<number> => {
  const errors = await submitChange(request);
  if (errors.length) {
    out.error(`not applied: ${errors.join("; ")}`);
    return Cli.ExitCode.FAIL;
  }
  show({ ok: true }, "applied to the ledger");
  return Cli.ExitCode.OK;
};

export const hybridCommand = async (
  sub: string | undefined,
  arg: string | undefined,
  json: boolean,
  out: { log(t: string): void; error(t: string): void } = console,
  outFile?: string
): Promise<number> => {
  const show = (data: unknown, text: string) => out.log(json ? JSON.stringify(data) : text);
  try {
    switch (sub) {
      case "list": {
        const { data } = await ActiveRequest.send(`${base()}/a/hybrid/list`, "GET");
        const rows = data as any[];
        show(
          rows,
          rows.length
            ? rows
                .map(
                  (h) =>
                    `${h.keyHash}  ${h.label ?? ""}  ${(h.endpoints ?? []).map((e: any) => `${e.transport}://${e.host}:${e.port}`).join(" ")}` +
                    `${h.retired ? "  retired" : ""}${h.banned ? "  banned" : ""}${h.feedConnected ? "  feed" : ""}`
                )
                .join("\n")
            : "no hybrids registered"
        );
        return Cli.ExitCode.OK;
      }
      case "feeds": {
        const { data } = await ActiveRequest.send(`${base()}/a/hybrid/feeds`, "GET");
        const s = data as any;
        show(
          s,
          `${s.count} of ${s.max} feeds\n` +
            s.feeds.map((f: any) => `${f.keyHash}  at ${f.cursor || "start"}  ${f.connectedSeconds}s`).join("\n")
        );
        return Cli.ExitCode.OK;
      }
      case "ban":
      case "unban": {
        if (!arg) {
          out.error(`hybrid ${sub} needs a key hash`);
          return Cli.ExitCode.FAIL;
        }
        const r = await ActiveRequest.send(`${base()}/a/hybrid/${sub}`, "POST", [], { keyHash: arg });
        if ((r as any).status && (r as any).status >= 400) {
          out.error((r.data as any)?.error ?? `${sub} failed`);
          return Cli.ExitCode.FAIL;
        }
        show({ ok: true }, `${sub === "ban" ? "banned" : "unbanned"} ${arg}`);
        return Cli.ExitCode.OK;
      }
      case "allow":
      case "deny":
      case "admission":
      case "min-version": {
        if (!arg) {
          out.error(`hybrid ${sub} needs ${sub === "allow" || sub === "deny" ? "a key, key hash or key file" : "a value"}`);
          return Cli.ExitCode.FAIL;
        }
        const change: HybridChange =
          sub === "allow" ? { allow: [keyArgument(arg)] }
          : sub === "deny" ? { deny: [keyArgument(arg)] }
          : sub === "admission" ? { admission: arg as HybridChange["admission"] }
          : { minVersion: arg };
        const request = buildChange(change);
        if (outFile) {
          fs.writeFileSync(outFile, JSON.stringify(request, null, 2));
          show({ file: outFile }, `wrote ${outFile}: have the other nodes run 'hybrid sign ${outFile}', then 'hybrid submit ${outFile}'`);
          return Cli.ExitCode.OK;
        }
        return await sendChange(request, show, out);
      }
      case "sign": {
        if (!arg) {
          out.error("hybrid sign needs the file written by --out");
          return Cli.ExitCode.FAIL;
        }
        const request = signChange(JSON.parse(fs.readFileSync(arg, "utf8")));
        fs.writeFileSync(arg, JSON.stringify(request, null, 2));
        show({ signers: signers(request) }, `signed by ${signers(request).join(", ")}`);
        return Cli.ExitCode.OK;
      }
      case "submit": {
        if (!arg) {
          out.error("hybrid submit needs the file written by --out");
          return Cli.ExitCode.FAIL;
        }
        return await sendChange(JSON.parse(fs.readFileSync(arg, "utf8")), show, out);
      }
      default:
        out.error(`hybrid needs a subcommand: list, feeds, ban <keyhash>, unban <keyhash>, allow <key>, deny <key>, admission <open|allowlist>, min-version <semver>, sign <file>, submit <file>`);
        return Cli.ExitCode.FAIL;
    }
  } catch (e: any) {
    out.error(`could not reach the node: ${e?.message ?? e}`);
    return Cli.ExitCode.STATE;
  }
};
