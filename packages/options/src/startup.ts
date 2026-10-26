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

import { banner, CliEnv, CliProgram, currentEnv } from "./cli";

export interface StartupOut {
  write(s: string): unknown;
}

export interface StartupOptions {
  out?: StartupOut;
  env?: CliEnv;
  json?: boolean;
  quiet?: boolean;
  // Started by systemd, pm2 and the like: one plain line per step
  managed?: boolean;
  // A step still running after this long says so, once
  slowAfterMs?: number;
}

export const isManaged = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!(env.INVOCATION_ID || env.pm_id || env.NODE_APP_INSTANCE);

type State = "wait" | "run" | "done" | "fail";

// Progress inside a step is printed at most this often
const PROGRESS_EVERY_MS = 2000;

/**
 * The start-up display. It reports real progress and never adds delay:
 * every call is driven by the start-up code, and its timer is unref'd.
 *
 * It only ever appends whole lines, and never redraws one in place. The node
 * is not the only thing writing to the terminal while it starts (the logger,
 * and the worker processes that share its output), and a line rewritten with
 * a carriage return ends up with their text on it. Each line is the chain as
 * far as the node has got:
 *
 *     [###]==[###]   identity
 *     [###]==[###]==[###]   database
 */
export class StartupDisplay {
  public readonly chain: boolean;
  private readonly out: StartupOut;
  private readonly env: CliEnv;
  private readonly slowAfterMs: number;
  private states: State[];
  private current = -1;
  private broken = false;
  private detail = "";
  private lastProgress = 0;
  private slow?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private program: CliProgram,
    private steps: string[],
    opts: StartupOptions = {}
  ) {
    this.out = opts.out || process.stdout;
    this.env = opts.env || currentEnv();
    this.slowAfterMs = opts.slowAfterMs ?? 1000;
    this.chain =
      this.env.isTTY &&
      !this.env.noColor &&
      !opts.json &&
      !opts.quiet &&
      !opts.managed;
    this.states = steps.map(() => "wait" as State);
    if (this.chain) {
      this.out.write(
        banner(program, { json: opts.json, quiet: opts.quiet }, this.env)
      );
    }
  }

  /** A step has started */
  public begin(step: string): void {
    const i = this.steps.indexOf(step);
    if (i < 0 || this.stopped) return;
    this.current = i;
    this.states[i] = "run";
    this.detail = "";
    this.clearSlow();
    if (!this.chain) return;
    // The rare break is drawn on the line of the step that rolls it
    this.broken = i > 0 && this.env.random() < 1 / 50;
    // Say so once if the step takes a while (waiting for the other nodes, say)
    this.slow = setTimeout(() => {
      if (this.states[i] === "run" && !this.stopped) {
        this.out.write(`${this.render()}  ...\n`);
      }
    }, this.slowAfterMs);
    this.slow.unref();
  }

  /** The current step finished */
  public done(step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "done";
    this.detail = "";
    this.clearSlow();
    this.out.write(this.chain ? `${this.render()}\n` : `ok  ${this.steps[i]}\n`);
    this.broken = false;
  }

  /** The current step failed: stop here and say why */
  public fail(reason: string, step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "fail";
    this.halt();
    if (this.chain) {
      this.out.write(`${this.render()}\n${reason}\n`);
    } else {
      this.out.write(`FAIL  ${this.steps[i]}: ${reason}\n`);
    }
  }

  /** Progress inside a step, e.g. a hybrid catching up. Throttled. */
  public progress(detail: string): void {
    if (this.stopped) return;
    this.detail = detail;
    const now = Date.now();
    if (this.chain && now - this.lastProgress >= PROGRESS_EVERY_MS) {
      this.lastProgress = now;
      this.out.write(`${this.render()}\n`);
    }
  }

  /** Lag counting down and the cursor, for a hybrid's catching up step */
  public catchUp(lagSeconds: number, cursor: string): void {
    this.progress(`${Math.max(0, Math.round(lagSeconds))}s behind  ${cursor}`);
  }

  /** The node is ready: stop, ordinary logs take over */
  public finish(): void {
    if (this.stopped) return;
    this.states = this.states.map((s) => (s === "fail" ? s : "done"));
    this.current = this.steps.length - 1;
    this.broken = false;
    this.halt();
    if (this.chain) this.out.write("\n");
  }

  /** A log line raised during start-up */
  public log(line: string): void {
    this.out.write(`${line}\n`);
  }

  /** What the chain line looks like now */
  public render(): string {
    const blocks = this.states.map((s, i) => {
      if (s === "done") return "[###]";
      if (s === "fail") return "[ X ]";
      if (s === "run" && i === this.current) return "[   ]";
      return null;
    });
    let line = "";
    let prev = false;
    blocks.forEach((b, i) => {
      if (b === null) return;
      if (prev) line += this.broken && i === this.current ? "=/=" : "==";
      line += b;
      prev = true;
    });
    const label = this.steps[this.current] ?? "";
    return `${line}   ${label}${this.detail ? "  " + this.detail : ""}`;
  }

  private clearSlow(): void {
    if (this.slow) clearTimeout(this.slow);
    this.slow = undefined;
  }

  private halt(): void {
    this.stopped = true;
    this.clearSlow();
  }
}
