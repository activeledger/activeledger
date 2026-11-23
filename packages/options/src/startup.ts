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

const CLEAR_LINE = "\r\u001b[2K";
// A running step cycles through these, filling like the done block does
const FRAMES = ["[   ]", "[.  ]", "[.. ]", "[...]"];

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
  // Kept for callers that set it; a running step now shows its seconds on the live line instead
  slowAfterMs?: number;
  // How often the live line is repainted while a step runs (ms)
  tickMs?: number;
  // How wide the terminal is (columns), so the live line never wraps
  columns?: number;
  // The clock, for tests
  now?: () => number;
}

export const isManaged = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!(env.INVOCATION_ID || env.pm_id || env.NODE_APP_INSTANCE);

type State = "wait" | "run" | "done" | "fail";

// Progress detail is repainted at most this often
const PROGRESS_EVERY_MS = 100;
// A step that has run this long shows its seconds
const SHOW_SECONDS_AFTER_MS = 2000;

/**
 * The start-up display. It reports real progress and never adds delay:
 * every call is driven by the start-up code, and its timer is unref'd.
 *
 * On a terminal the progress is one live line under the banner: the chain as
 * far as the node has got, the running block cycling `[   ]` `[.  ]` `[.. ]`
 * `[...]`, the step's name and, once a step is slow, how long it has run:
 *
 *     [###]==[###]==[...]   consensus  (4s)
 *
 * The line is rewritten in place (clear the line, draw it again). Log lines
 * raised during start-up come through `log()`, which clears the live line,
 * prints the log line whole, and draws the live line again beneath it, so the
 * logger never ends up on the line. Anything else that writes to the terminal
 * (a worker process) just leaves the stale line above it and the next repaint
 * draws a fresh one. When output is not a terminal, or under NO_COLOR, --json,
 * --quiet or a process manager, there is no live line: one plain line per step.
 */
export class StartupDisplay {
  public readonly chain: boolean;
  private readonly out: StartupOut;
  private readonly env: CliEnv;
  private readonly tickMs: number;
  private readonly columns: number;
  private readonly now: () => number;
  private states: State[];
  private current = -1;
  private broken = false;
  private detail = "";
  private lastProgress = 0;
  private stepStartedAt = 0;
  private startedAt: number;
  private frame = 0;
  private live = false;
  private ticker?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private program: CliProgram,
    private steps: string[],
    opts: StartupOptions = {}
  ) {
    this.out = opts.out || process.stdout;
    this.env = opts.env || currentEnv();
    this.tickMs = opts.tickMs ?? 250;
    this.columns = opts.columns ?? (process.stdout.columns || 80);
    this.now = opts.now || Date.now;
    this.startedAt = this.now();
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
    this.stepStartedAt = this.now();
    if (!this.chain) return;
    // The rare break is drawn on the line of the step that rolls it
    this.broken = i > 0 && this.env.random() < 1 / 50;
    this.paint();
    this.startTicker();
  }

  /** The current step finished */
  public done(step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "done";
    this.detail = "";
    if (this.chain) {
      this.paint();
    } else {
      this.out.write(`ok  ${this.steps[i]}\n`);
    }
    this.broken = false;
  }

  /** The current step failed: stop here and say why */
  public fail(reason: string, step?: string): void {
    const i = step ? this.steps.indexOf(step) : this.current;
    if (i < 0 || this.stopped) return;
    this.states[i] = "fail";
    this.halt();
    if (this.chain) {
      this.out.write(`${this.clear()}${this.render()}\n${reason}\n`);
      this.live = false;
    } else {
      this.out.write(`FAIL  ${this.steps[i]}: ${reason}\n`);
    }
  }

  /** Progress inside a step, e.g. a hybrid catching up. Repainted at most every 100ms. */
  public progress(detail: string): void {
    if (this.stopped) return;
    this.detail = detail;
    const now = this.now();
    if (this.chain && now - this.lastProgress >= PROGRESS_EVERY_MS) {
      this.lastProgress = now;
      this.paint();
    }
  }

  /** Lag counting down and the cursor, for a hybrid's catching up step */
  public catchUp(lagSeconds: number, cursor: string): void {
    this.progress(`${Math.max(0, Math.round(lagSeconds))}s behind  ${cursor}`);
  }

  /** The node is ready: the line is filled in, it stays, and ordinary logs take over */
  public finish(): void {
    if (this.stopped) return;
    this.states = this.states.map((s) => (s === "fail" ? s : "done"));
    this.current = this.steps.length - 1;
    this.broken = false;
    this.detail = "";
    this.halt();
    if (this.chain) {
      const seconds = ((this.now() - this.startedAt) / 1000).toFixed(1);
      this.out.write(`${this.clear()}${this.fit(`${this.render()}  (${seconds}s)`)}\n\n`);
      this.live = false;
    }
  }

  /** A log line raised during start-up: whole, on its own line, with the live line drawn again beneath it */
  public log(line: string): void {
    if (this.chain && this.live) {
      this.out.write(`${this.clear()}${line}\n`);
      this.live = false;
      this.paint();
    } else {
      this.out.write(`${line}\n`);
    }
  }

  /** What the chain line looks like now (the running block is `[   ]`; the live line animates it) */
  public render(frame = FRAMES[0]): string {
    const blocks = this.states.map((s, i) => {
      if (s === "done") return "[###]";
      if (s === "fail") return "[ X ]";
      if (s === "run" && i === this.current) return frame;
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

  /** The live line: the running block animated, and the seconds once the step is slow */
  private renderLive(): string {
    let text = this.render(FRAMES[this.frame % FRAMES.length]);
    const running = this.now() - this.stepStartedAt;
    if (this.states[this.current] === "run" && running >= SHOW_SECONDS_AFTER_MS) {
      text += `  (${Math.floor(running / 1000)}s)`;
    }
    return this.fit(text);
  }

  /** Never wider than the terminal, or the clear would miss the wrapped part */
  private fit(text: string): string {
    return text.length >= this.columns ? text.slice(0, Math.max(1, this.columns - 1)) : text;
  }

  private clear(): string {
    return this.live ? CLEAR_LINE : "";
  }

  private paint(): void {
    if (this.stopped) return;
    this.out.write(`${CLEAR_LINE}${this.renderLive()}`);
    this.live = true;
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (this.stopped) return;
      this.frame++;
      if (this.states[this.current] === "run") this.paint();
    }, this.tickMs);
    this.ticker.unref();
  }

  private halt(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
