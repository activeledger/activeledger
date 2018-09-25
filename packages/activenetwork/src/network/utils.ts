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

import * as os from "os";
import * as restify from "restify";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from '@activeledger/activeoptions';

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
   * @memberof ActiveInterfaces
   */
  private static bindingHost: string;

  /**
   * The port Activeledger has bound to
   *
   * @private
   * @static
   * @type {number}
   * @memberof ActiveInterfaces
   */
  private static bindingPort: number;

  /**
   * Get Binding Information (Type of Getter, Read Only)
   *
   * @static
   * @param {string} type
   * @returns {string}
   * @memberof ActiveInterfaces
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
   * @memberof ActiveInterfaces
   */
  private static findBinding(): void {
    // Return if already bound
    if (this.bindingHost && this.bindingPort) return;

    // Get Arguments & Configuration
    let argv = ActiveOptions.fetch(true);
    let config = ActiveOptions.fetch(false);

    // Is host defined?
    if (config.host) {
      let [host, port] = config.host.split(":");
      this.bindingHost = host;
      this.bindingPort = parseInt(port);
    } else {
      if (argv.host) {
        let [host, port] = argv.host.split(":");
        if (port) {
          this.bindingHost = host;
          this.bindingPort = parseInt(port);
          return;
        } else {
          if (argv.port) {
            this.bindingHost = host;
            this.bindingPort = argv.port;
          } else {
            this.bindingHost = host;
            this.bindingPort = 5260;
          }
        }
      } else {
        // Get Local IP address
        let interfaces = os.networkInterfaces();

        let ifname = Object.keys(interfaces);
        let ifs = ifname.length;

        // Loop Network Interfaces, Find first ip4 external
        networkLoop: while (ifs--) {
          let ifaces = interfaces[ifname[ifs]].length;
          while (ifaces--) {
            const iface = interfaces[ifname[ifs]][ifaces];
            // Skip internal or none ip4 address.
            if (!iface.internal || iface.family !== "IPv4") {
              break;
            }
            if (argv.port) {
              this.bindingHost = iface.address;
              this.bindingPort = argv.port;
            } else {
              this.bindingHost = iface.address;
              this.bindingPort = 5260;
            }
            break networkLoop;
          }
        }
      }
    }
  }
}
