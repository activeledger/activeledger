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

import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions, StartupDisplay, isManaged } from "@activeledger/activeoptions";
import { supernodeProgram } from "./program";

export const STARTUP_STEPS = [
  "config",
  "identity",
  "database",
  "network",
  "consensus",
  "ready",
];

/**
 * The supernode's start-up display. Every call is a no-op until init, so
 * the code that reports progress does not need to know whether it is shown.
 */
export class Startup {
  private static display?: StartupDisplay;

  public static init(version: string): void {
    Startup.display = new StartupDisplay(supernodeProgram(version), STARTUP_STEPS, {
      json: !!ActiveOptions.get<boolean>("json", false),
      quiet: !!ActiveOptions.get<boolean>("quiet", false),
      managed: isManaged(),
    });
    // Log lines raised during start-up print above the display
    ActiveLogger.sink = (line) => Startup.display?.log(line);
  }

  public static begin(step: string): void {
    Startup.display?.begin(step);
  }

  public static done(step?: string): void {
    Startup.display?.done(step);
  }

  public static fail(reason: string, step?: string): void {
    Startup.release();
    Startup.display?.fail(reason, step);
    Startup.display = undefined;
  }

  public static finish(): void {
    Startup.release();
    Startup.display?.finish();
    Startup.display = undefined;
  }

  private static release(): void {
    ActiveLogger.sink = undefined;
  }
}
