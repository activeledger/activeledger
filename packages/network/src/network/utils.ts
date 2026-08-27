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
import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * Manages Hardware Interface (Networking)
 *
 * @export
 * @class ActiveInterfaces
 */
export class ActiveInterfaces {
  /**
   * The host Activeledger has bound to
   *
   * @private
   * @static
   * @type {string}
   */
  private static bindingHost: string;

  /**
   * The port Activeledger has bound to
   *
   * @private
   * @static
   * @type {number}
   */
  private static bindingPort: number;

  /**
   * Get Binding Information (Type of Getter, Read Only)
   *
   * @static
   * @param {string} type
   * @returns {string}
   */
  public static getBindingDetails(type: string): string;
  public static getBindingDetails(type: string, num: boolean): number;
  public static getBindingDetails(type: string): any {
    // Make sure we have found the bindings
    ActiveInterfaces.findBinding();
    if (type == "host") {
      return this.bindingHost;
    } else {
      return this.bindingPort;
    }
  }

  /**
   * Find how Activeledger should be bound to the network
   *
   * @private
   * @static
   * @returns {void}
   */
  private static findBinding(): void {
    // Return if already bound
    if (this.bindingHost && this.bindingPort) return;

    // Get Arguments & Configuration
    let argv = ActiveOptions.fetch(true);
    let config = ActiveOptions.fetch(false);

    // Determine host and port from config file first, then command-line arguments.
    const hostString = config.host || argv.host;

    if (hostString) {
      const [host, portStr] = hostString.split(":");
      this.bindingHost = host;

      // Use port from host string, then from --port argument, then default.
      let port = parseInt(portStr, 10);
      if (isNaN(port)) {
        port = argv.port;
      }
      if (isNaN(port)) {
        port = 5260;
      }
      this.bindingPort = port;
    } else {
      // Fallback for when only --port is provided without a host
      const port = parseInt(argv.port, 10);
      if (argv.host === undefined && !isNaN(port)) {
        // This case is unlikely but handled for completeness.
        // It assumes a default host if only a port is specified.
        this.bindingPort = port;
      } else {
        throw new Error("IP:Port Binding not found in configuration or arguments.");
      }
    }
  }
}
