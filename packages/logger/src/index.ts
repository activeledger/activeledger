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

import * as process from "process";

let tracer: any;

if (process.env.ddReady) {
  //@ts-ignore
  import("dd-trace")
    .then((dd) => {
      tracer = dd.tracer;
      tracer.__inject = (level: string, message: any) => {
        const span = tracer.scope().active();
        const time = new Date().toISOString();
        const record = { time, level, message };

        if (span) {
          tracer.inject(span.context(), "log", record);
        }
      };
    })
    .catch();
}

/**
 * Simplified Logging
 *
 * @export
 * @class ActiveLogger
 */
export class ActiveLogger {
  /**
   * Enable extra debug messages
   *
   * @static
   * @type {boolean}
   */
  public static enableDebug: boolean = false;

  /**
   * Holds the value of where the call is coming from
   *
   * @static
   * @type {boolean}
   */
  public static isVMRuntime: boolean = false;

  /**
   * Creates a trace log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public static trace(obj: object, msg?: string, ...args: any[]): void;
  public static trace(msg: string, ...args: any[]): void;
  public static trace(p1: any, p2: any, args: any): void {
    if (ActiveLogger.enableDebug) {
      if (tracer?.__inject) {
        tracer.__inject("trace", p1);
      }
      // Get Output String
      let out =
        ActiveLogger.timestamp() +
        ActiveLogger.colour("TRACE", 42) +
        ActiveLogger.process() +
        ActiveLogger.colour(p2 || p1, this.isVM());

      // Is there an object?
      if (p2) {
        out += ActiveLogger.object(p1);
      }

      // Output
      console.trace();
      console.debug(out);
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public trace(obj: object, msg?: string, ...args: any[]): void;
  public trace(msg: string, ...args: any[]): void;
  public trace(p1: any, p2: any, args: any): void {
    ActiveLogger.trace(p1, p2);
  }

  /**
   * Creates an debug log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public static debug(obj: object, msg?: string, ...args: any[]): void;
  public static debug(msg: string, ...args: any[]): void;
  public static debug(p1: any, p2: any, args: any): void {
    if (ActiveLogger.enableDebug) {
      if (tracer?.__inject) {
        tracer.__inject("debug", p1);
      }
      // Get Output String
      let out =
        ActiveLogger.timestamp() +
        ActiveLogger.colour("DEBUG", 46) +
        ActiveLogger.process() +
        ActiveLogger.colour(p2 || p1, ActiveLogger.isVM());

      // Is there an object?
      if (p2) {
        out += ActiveLogger.object(p1);
      }

      // Output
      console.debug(out);
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public debug(obj: object, msg?: string, ...args: any[]): void;
  public debug(msg: string, ...args: any[]): void;
  public debug(p1: any, p2: any, args: any): void {
    ActiveLogger.debug(p1, p2);
  }

  /**
   * Creates an information log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public static info(obj: object, msg?: string, ...args: any[]): void;
  public static info(msg: string, ...args: any[]): void;
  public static info(p1: any, p2: any, args: any): void {
    if (tracer?.__inject) {
      tracer.__inject("info", p1);
    }
    // Get Output String
    let out =
      ActiveLogger.timestamp() +
      ActiveLogger.colour("INFO ", 92) +
      ActiveLogger.process() +
      ActiveLogger.colour(p2 || p1, ActiveLogger.isVM());

    // Is there an object?
    if (p2) {
      out += ActiveLogger.object(p1);
    }

    // Output
    console.info(out);
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public info(obj: object, msg?: string, ...args: any[]): void;
  public info(msg: string, ...args: any[]): void;
  public info(p1: any, p2: any, args: any): void {
    ActiveLogger.info(p1, p2);
  }

  /**
   * Creates a warning log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public static warn(obj: object, msg?: string, ...args: any[]): void;
  public static warn(msg: string, ...args: any[]): void;
  public static warn(p1: any, p2: any, args: any): void {
    if (tracer?.__inject) {
      tracer.__inject("warn", p1);
    }
    // Get Output String
    let out =
      ActiveLogger.timestamp() +
      ActiveLogger.colour("WARN ", 93) +
      ActiveLogger.process() +
      ActiveLogger.colour(p2 || p1, ActiveLogger.isVM());

    // Is there an object?
    if (p2) {
      out += ActiveLogger.object(p1);
    }

    // Output
    console.warn(out);
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public warn(obj: object, msg?: string, ...args: any[]): void;
  public warn(msg: string, ...args: any[]): void;
  public warn(p1: any, p2: any, args: any): void {
    ActiveLogger.warn(p1, p2);
  }

  /**
   * Creates an error log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public static error(obj: object, msg?: string, ...args: any[]): void;
  public static error(msg: string, ...args: any[]): void;
  public static error(p1: any, p2: any, args: any): void {
    // if (process.env.ddReady && tracer) {
    //   if (tracer?.__inject) {
    //     tracer.__inject("error", p1);
    //   }
    //   const span = tracer.scope().active();
    //   if (span) {
    //     const parent = (span.context() as any)._trace.started[0];
    //     if (parent) {
    //       parent.addTags({
    //         "error.msg": (p1 as any).message,
    //         "error.stack": (p1 as any).stack,
    //         "error.type": (p1 as any).name,
    //       });
    //     }
    //   }
    // }

    // Get Output String
    let out =
      ActiveLogger.timestamp() +
      ActiveLogger.colour("ERROR", 91) +
      ActiveLogger.process() +
      ActiveLogger.colour(p2 || p1, ActiveLogger.isVM());

    // Is there an object?
    if (p2) {
      out += ActiveLogger.object(p1);
    }

    // Output
    console.error(out);
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public error(obj: object, msg?: string, ...args: any[]): void;
  public error(msg: string, ...args: any[]): void;
  public error(p1: any, p2: any, args: any): void {
    ActiveLogger.error(p1, p2);
  }

  /**
   * Creates a fatal log entry and returns throwable error
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @returns {Error}
   */
  public static fatal(obj: object, msg?: string, ...args: any[]): Error;
  public static fatal(msg: string, ...args: any[]): Error;
  public static fatal(p1: any, p2: any, args: any): Error {
    if (tracer?.__inject) {
      tracer.__inject("fatal", p1);
    }
    // Get Output String
    let out =
      ActiveLogger.timestamp() +
      ActiveLogger.colour("FATAL", 41) +
      ActiveLogger.process() +
      ActiveLogger.colour(p2 || p1, ActiveLogger.isVM());

    // Is there an object?
    if (p2) {
      out += ActiveLogger.object(p1);
    }

    // Output
    console.error(out);

    // Return Error Object
    return new Error(p2 || p1);
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   */
  public fatal(obj: object, msg?: string, ...args: any[]): void;
  public fatal(msg: string, ...args: any[]): void;
  public fatal(p1: any, p2: any, args: any): void {
    ActiveLogger.fatal(p1, p2);
  }

  /**
   * Set VM Runtime as static
   *
   * @static
   * @param {boolean} isVM
   */
  public static setVMRuntime(isVM: boolean): void {
    ActiveLogger.isVMRuntime = isVM;
  }

  /**
   * Definition Proxy
   *
   * @param {boolean} isVM
   */
  public setVMRuntime(isVM: boolean): void {
    ActiveLogger.isVMRuntime = isVM;
  }

  /**
   * Detects if called from within VM
   *
   * @private
   * @static
   * @returns {number}
   */
  private static isVM(): number {
    return ActiveLogger.isVMRuntime ? 93 : 36;
  }

  /**
   * Timestamp Formatted Console string
   *
   * @private
   * @static
   * @returns {string}
   */
  private static timestamp(): string {
    return `${ActiveLogger.colour(`[${new Date().getTime()}]`, 90)} `;
  }

  /**
   * Process Id Formatted Console string
   *
   * @private
   * @static
   * @returns {string}
   */
  private static process(): string {
    return ` ${ActiveLogger.colour(
      `(Activeledger/${process.pid.toString().padStart(5, "0")})`,
      90
    )} `;
  }

  /**
   * Object Formatted Console string
   *
   * @private
   * @static
   * @param {*} obj
   * @returns {string}
   */
  private static object(obj: any): string {
    // Convert to string
    let objectStr = JSON.stringify(obj, null, 2)?.slice(1, -1);

    // Get Output String
    let out = "";

    // Is the object not empty?
    if (objectStr) {
      out += `\r\n-------------${ActiveLogger.colour(
        "[ OBJECT ]",
        32
      )}-------------`;
      out += objectStr;
      out += `-------------${ActiveLogger.colour(
        "[ OBJECT ]",
        31
      )}-------------`;
    } else {
      if (obj?.toString) {
        out += `\r\n-------------${ActiveLogger.colour(
          "[ toString() ]",
          32
        )}-------------\r\n`;
        out += obj.toString();
        out += `\r\n-------------${ActiveLogger.colour(
          "[ toString() ]",
          31
        )}-------------`;
      }
    }
    return out;
  }

  /**
   * Console Colour Formatter
   *
   * @private
   * @static
   * @param {string} text
   * @param {number} colour
   * @returns {string}
   */
  private static colour(text: string, colour: number): string {
    if (process && process.pid) {
      return `\x1b[${colour}m${text}\x1b[0m`;
    }
    return text;
  }
}
