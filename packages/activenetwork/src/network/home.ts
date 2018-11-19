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
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Neighbour } from "./neighbour";
import { Neighbourhood, NeighbourStatus } from "./neighbourhood";
import { ActiveInterfaces } from "./utils";

/**
 * Represents this Activeledger node's home within the network neighbourhood
 *
 * @export
 * @class Home
 * @extends {Neighbour}
 */
export class Home extends Neighbour {
  /**
   * Contains all the information about the possible neighbourhood but
   * doesn't know who is active or not unless master process.
   * This is the reason for Left & Right for child processes.
   *
   * @type {Neighbourhood}
   * @memberof Home
   */
  public neighbourhood: Neighbourhood = new Neighbourhood();

  /**
   * This nodes identity signing authority, Cannot be readonly
   * with this post identity build assign method.
   *
   * @static
   * @type {ActiveCrypto.KeyPair}
   * @memberof Home
   */
  public static identity: ActiveCrypto.KeyPair;

  /**
   * Cache public pem string for exposing
   *
   * @static
   * @type {string}
   * @memberof Home
   */
  public static publicPem: string;

  /**
   * Node to the left of our Home
   *
   * @static
   * @type {Neighbour}
   * @memberof Home
   */
  public static left: Neighbour;

  /**
   * Node to the right of our Home
   *
   * @static
   * @type {Neighbour}
   * @memberof Home
   */
  public static right: Neighbour;

  /**
   * Also need global scope for this host home node reference
   *
   * @static
   * @type {string}
   * @memberof Home
   */
  public static reference: string;

  /**
   * Also need global scope for this host location details
   *
   * @static
   * @type {string}
   * @memberof Home
   */
  public static host: string;

  /**
   * Holds the territoriality map
   *
   * @private
   * @type {string[]}
   * @memberof Home
   */
  private tMap: string[];

  /**
   * Creates an instance of Home.
   * @memberof Home
   */
  constructor() {
    // Avoid calling super first error
    super(
      ActiveInterfaces.getBindingDetails("host"),
      ActiveInterfaces.getBindingDetails("port", true)
    );

    // Identity file now Exists read (when .identity doesn't exist cannot build static)
    let identityConfig = JSON.parse(
      fs.readFileSync(ActiveOptions.get("identity", "./.identity"), "utf8")
    );

    // Assign static identity
    Home.identity = new ActiveCrypto.KeyPair(
      "rsa",
      identityConfig.prv.pkcs8pem
    );

    // Set Public Pem
    Home.publicPem = Buffer.from(identityConfig.pub.pkcs8pem).toString(
      "base64"
    );

    // If we run behind a proxy we need to update our reference so we can connect correctly
    if (ActiveOptions.get("proxy", false)) {
      this.reference = ActiveCrypto.Hash.getHash(
        this.host +
          ActiveOptions.get<string>("proxy") +
          ActiveOptions.get<string>("network", ""),
        "sha1"
      );
    }

    // Set This homes reference
    Home.reference = this.reference;

    // Set Self Host (Used for Contracts to know who is where)
    Home.host = `${this.host}:${this.port}`;

    // Setup Default Neighbours
    if (!Home.left) {
      Home.left = new Neighbour(this.host, this.port);
    }

    if (!Home.right) {
      Home.right = new Neighbour(this.host, this.port);
    }

    // Get Network Map
    this.terriBuildMap();
  }

  /**
   * Sign data if the configuration enabled signing transactions
   *
   * @static
   * @param {string} data
   * @returns {(string | null)}
   * @memberof Home
   */
  public static sign(data: string): string | null {
    if (ActiveOptions.get<any>("security", {}).signedConsensus) {
      return Home.identity.sign(data);
    }
    return null;
  }

  /**
   * Decrypt Proxy
   *
   * @static
   * @param {*} data
   * @returns {*}
   * @memberof Home
   */
  public decrypt(data: any): any {
    return Home.identity.decrypt(data);
  }

  /**
   * Gets the current host home status
   *
   * @returns {NeighbourStatus}
   * @memberof Home
   */
  public getStatus(): NeighbourStatus {
    // Only Connected to itself
    if (
      this.reference == Home.right.reference &&
      this.reference == Home.left.reference
    ) {
      return NeighbourStatus.Unrecognised;
    }

    // Connected to everyone but itself
    if (
      this.reference != Home.right.reference &&
      this.reference != Home.left.reference
    ) {
      return NeighbourStatus.Stable;
    }

    // Process of connecting (2 node > are needed)
    return NeighbourStatus.Pairing;
  }

  /**
   * Builds a map of which nodes are where in execution order
   * similair to Maintain.createNetworkOrder however not accessible right now
   *
   * @param {string} commitAt
   * @returns {string}
   * @memberof Home
   */
  public terriBuildMap(): void {
    // Get the neighbours
    let neighbourhood = this.neighbourhood.get();
    let keys = this.neighbourhood.keys();
    let i = keys.length;

    // Temporary Array for holding references
    let tempMap: string[] = [];

    // Loop all neighbours
    while (i--) {
      // Add to temporary array (Unless stopping)
      let neighbour = neighbourhood[keys[i]];
      if (!neighbour.graceStop) {
        tempMap.push(neighbour.reference);
      }
    }

    // Sort the order of the neighbours
    this.tMap = tempMap.sort(
      (x, y): number => {
        if (x > y) return 1;
        return -1;
      }
    );
  }

  /**
   * Return which entry node is needed for the commit to happen where
   * this assumes all nodes will vote yes
   *
   * @param {string} commitAt
   * @returns {string}
   * @memberof Home
   */
  public terriMap(commitAt: string): string {
    // How many votes are needed for consesus
    // Round up as we need whole number int for lookup
    let votes = Math.ceil(
      (ActiveOptions.get<any>("consensus", {}).reached / 100) * this.tMap.length
    );

    // Get Commit Position
    let commitPos = this.tMap.indexOf(commitAt);

    // Make sure it exists
    if (commitPos !== -1) {
      // Current position (Plus 1 for index)
      let sendPos = this.tMap.indexOf(commitAt) - votes + 1;

      // In range?
      if (sendPos >= 0) {
        return this.tMap[sendPos];
      } else {
        return this.tMap.slice(sendPos)[0];
      }
    }

    // Blank string for unknown
    return "";
  }

  /**
   * Sets up this homes immediate neighbours
   *
   * @param {boolean} moan
   * @param {string | null} left
   * @param {string | null} right
   * @returns {void}
   * @memberof Home
   */
  public setNeighbours(
    moan: boolean,
    left: string | null,
    right: string | null
  ): void {
    // IPC Call
    if (moan) {
      this.moan("neighbour", { left: left, right: right });
    } else {
      // Check to make sure this is a new neighbour
      if (right) this.setRight(right);
      if (left) this.setLeft(left);
    }
  }

  /**
   * Sets its right neighbour
   *
   * @param {Neighbour} right
   * @memberof Host
   */
  public setRight(right: string): void {
    if (right) {
      // Set for this process
      Home.right = this.neighbourhood.get(right);

      // Still able to connect or shutdowning from the network?
      if (Home.right && !Home.right.graceStop) {
        // We know isHome
        Home.right.isHome = true;
      } else {
        Home.right = new Neighbour(this.host, this.port);
      }
    }
  }

  /**
   * Sets its left neighbour
   *
   * @param {Neighbour} left
   * @memberof Host
   */
  public setLeft(left: string): void {
    if (left) {
      // Set for this process
      Home.left = this.neighbourhood.get(left);

      // Still able to connect or shutdowning from the network?
      if (Home.left && !Home.left.graceStop) {
        // We know isHome
        Home.left.isHome = true;
      } else {
        Home.left = new Neighbour(this.host, this.port);
      }
    }
  }

  /**
   * Send a message back to the master process
   * Workers Moan, Master Shouts
   *
   * @param {string} type
   * @param {*} data
   * @memberof Host
   */
  public moan(type: string, data: any = {}): void {
    // Add type to data
    data.type = type;

    // Call IPC for moan
    (process as any).send(data);
  }
}
