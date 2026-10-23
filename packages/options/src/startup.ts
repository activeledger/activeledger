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

import { CliEnv, CliProgram, currentEnv } from "./cli";

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
  // Wait before a running block shows a spinner
  spinnerAfterMs?: number;
}

const SPINNER = ["|", "/", "-", "\\"];
const CLEAR = "\r\u001b[2K";

export const isManaged = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!(env.INVOCATION_ID || env.pm_id || env.NODE_APP_INSTANCE);

type State = "wait" | "run" | "done" | "fail";

/**
 * The start-up display. It reports real progress and never adds delay:
 * every call is driven by the start-up code, and its timers are unref'd.
 */
export class StartupDisplay {
  public readonly chain: boolean;
  private readonly out: StartupOut;
  private readonly env: CliEnv;
  private readonly spinnerAfterMs: number;
  private states: State[];
  private current = -1;
  private since = 0;
  private frame = 0;
  private broken = false;
  private detail = "";
  private timer?: NodeJS.Timeout;
  private mend?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private program: CliProgram,
    private steps: string[],
    opts: StartupOptions = {}
  ) {
    this.out = opts.out || process.stdout;
    this.env = opts.env || currentEnv();
    this.spinnerAfterMs = opts.spinnerAfterMs ?? 1000;
    this.chain =
      this.env.isTTY &&
      !this.env.noColor &&
      !opts.json &&
      !opts.quiet &&
      !opts.managed;
    this.states = steps.map(() => "wait" as State);
    if (this.chain) this.out.write(`${program.name} ${program.version}\n`);
  }

  /** A step has started */
  public begin(step: string): void {
    const i = this.steps.indexOf(step);
    if (i < 0 || this.stopped) return;
    this.current = i;
    this.states[i] = "run";
    this.since = Date.now();
    this.detail = "";
    // The rare break is only drawn while a step is already running
    if (this.chain && i > 0 && this.env.random() < 1 / 50) {
      this.broken = true;
      this.mend = setTimeout(() => {
        this.broken = false;
        this.draw();
      }, 600);
      this.mend.unref();
    }
    if (this.chain && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.draw();
      }, 120);
      this.timer.unref();
    }
    this.draw();
  }

  /** The current step finished */
  public done(step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "done";
    this.detail = "";
    if (!this.chain) this.out.write(`ok  ${this.steps[i]}\n`);
    else this.draw();
  }

  /** The current step failed: stop here and say why */
  public fail(reason: string, step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "fail";
    this.halt();
    if (this.chain) {
      this.draw();
      this.out.write(`\n${reason}\n`);
    } else {
      this.out.write(`FAIL  ${this.steps[i]}: ${reason}\n`);
    }
  }

  /** Progress inside a step, e.g. a hybrid catching up */
  public progress(detail: string): void {
    if (this.stopped) return;
    this.detail = detail;
    this.draw();
  }

  /** Lag counting down and the cursor, for a hybrid's catching up step */
  public catchUp(lagSeconds: number, cursor: string): void {
    this.progress(`${Math.max(0, Math.round(lagSeconds))}s behind  ${cursor}`);
  }

  /** The node is ready: stop drawing, ordinary logs take over */
  public finish(): void {
    if (this.stopped) return;
    this.states = this.states.map((s) => (s === "fail" ? s : "done"));
    this.current = this.steps.length - 1;
    this.halt();
    if (this.chain) {
      this.draw();
      this.out.write("\n");
    }
  }

  /** A log line raised during start-up, printed above the display */
  public log(line: string): void {
    if (this.chain && !this.stopped) {
      this.out.write(`${CLEAR}${line}\n`);
      this.draw();
    } else {
      this.out.write(`${line}\n`);
    }
  }

  /** What the chain line looks like now */
  public render(): string {
    const blocks = this.states.map((s, i) => {
      if (s === "done") return "[###]";
      if (s === "fail") return "[ X ]";
      if (s === "run" && i === this.current) {
        const slow = Date.now() - this.since >= this.spinnerAfterMs;
        return slow ? `[ ${SPINNER[this.frame % SPINNER.length]} ]` : "[   ]";
      }
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

  private draw(): void {
    if (!this.chain) return;
    this.out.write(`${CLEAR}${this.render()}`);
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.mend) clearTimeout(this.mend);
    this.timer = this.mend = undefined;
  }
}
