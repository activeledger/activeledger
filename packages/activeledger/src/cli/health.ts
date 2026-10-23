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
import { Cli } from "@activeledger/activeoptions";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait for a process to exit, true if it did within the timeout
 */
export const waitForExit = async (
  pid: number,
  timeoutSeconds: number
): Promise<boolean> => {
  const end = Date.now() + timeoutSeconds * 1000;
  while (alive(pid)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

/**
 * `status`: ready means the node's process is running
 */
export const status = async (json: boolean): Promise<number> => {
  // Read the PID file directly: PIDHandler.init creates it, and status must not
  let pid = 0;
  try {
    pid = JSON.parse(fs.readFileSync(".PID", "utf8")).activeledger || 0;
  } catch {
    // No PID file means not running
  }
  const ready = !!pid && alive(pid);
  Cli.printResult(
    { ready, pid: ready ? pid : null },
    json,
    (d) => (d.ready ? `ready (pid ${d.pid})` : "not running")
  );
  return ready ? Cli.ExitCode.OK : Cli.ExitCode.STATE;
};

/**
 * `check-config`: the file must exist, parse, and hold the sections a node needs
 */
export const checkConfigFile = (file: string, json: boolean): number => {
  let reason = "";
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const missing = ["host", "db"].filter((k) => config[k] === undefined);
    if (missing.length) reason = `missing ${missing.join(", ")}`;
  } catch (e: any) {
    reason = e.code === "ENOENT" ? `${file} not found` : `${file}: ${e.message}`;
  }
  Cli.printResult(
    { valid: !reason, file, reason: reason || undefined },
    json,
    (d) => (d.valid ? `${file} is valid` : `${file} is not valid: ${d.reason}`)
  );
  return reason ? Cli.ExitCode.STATE : Cli.ExitCode.OK;
};
