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

import * as pino from "pino";
import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * Logger Abstraction
 *
 * @export
 * @class logger
 */
export class ActiveLogger {
  /**
   * Standard Logger Object
   *
   * @private
   * @type {pino.Logger}
   * @memberof logger
   */
  private static logger: pino.Logger = pino({
    name: "Activeledger",
    level: process.env.NODE_ENV == "production" ? "info" : "debug",
    prettyPrint: true
  });

  /**
   * Creates a trace log entry
   *
   * @static
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
   */
  public static trace(obj: object, msg?: string, ...args: any[]): void;
  public static trace(msg: string, ...args: any[]): void;
  public static trace(p1: any, p2: any, args: any): void {    
    if (ActiveOptions.get<boolean>("debug", false)) {
      if (typeof p1 == "object") {
        this.logger.trace(p1, p2, args || "");
      } else {
        this.logger.trace(p1, args || "");
      }
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
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
   * @memberof ActiveLogger
   */
  public static debug(obj: object, msg?: string, ...args: any[]): void;
  public static debug(msg: string, ...args: any[]): void;
  public static debug(p1: any, p2: any, args: any): void {
    if (typeof p1 == "object") {
      this.logger.debug(p1, p2, args || "");
    } else {
      this.logger.debug(p1, args || "");
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
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
   * @memberof ActiveLogger
   */
  public static info(obj: object, msg?: string, ...args: any[]): void;
  public static info(msg: string, ...args: any[]): void;
  public static info(p1: any, p2: any, args: any): void {
    if (typeof p1 == "object") {
      this.logger.info(p1, p2, args || "");
    } else {
      this.logger.info(p1, args || "");
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
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
   * @memberof ActiveLogger
   */
  public static warn(obj: object, msg?: string, ...args: any[]): void;
  public static warn(msg: string, ...args: any[]): void;
  public static warn(p1: any, p2: any, args: any): void {
    if (typeof p1 == "object") {
      this.logger.warn(p1, p2, args || "");
    } else {
      this.logger.warn(p1, args || "");
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
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
   * @memberof ActiveLogger
   */
  public static error(obj: object, msg?: string, ...args: any[]): void;
  public static error(msg: string, ...args: any[]): void;
  public static error(p1: any, p2: any, args: any): void {
    if (typeof p1 == "object") {
      this.logger.error(p1, p2, args || "");
    } else {
      this.logger.error(p1, args || "");
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
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
   * @memberof ActiveLogger
   */
  public static fatal(obj: object, msg?: string, ...args: any[]): Error;
  public static fatal(msg: string, ...args: any[]): Error;
  public static fatal(p1: any, p2: any, args: any): Error {
    if (typeof p1 == "object") {
      this.logger.fatal(p1, p2, args || "");
      return new Error(p2);
    } else {
      this.logger.fatal(p1, args || "");
      return new Error(p1);
    }
  }

  /**
   * Definition Proxy
   *
   * @param {object} obj
   * @param {string} [msg]
   * @param {...any[]} args
   * @memberof ActiveLogger
   */
  public fatal(obj: object, msg?: string, ...args: any[]): void;
  public fatal(msg: string, ...args: any[]): void;
  public fatal(p1: any, p2: any, args: any): void {
    ActiveLogger.fatal(p1, p2);
  }
}
