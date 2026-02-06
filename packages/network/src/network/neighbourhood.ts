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
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Neighbour } from "./neighbour";

/**
 * The status within the neighbourhood
 * Unrecognised = No neighbours know who you are
 * Pairing = Some neighbours think they know you
 * Recognised = You're known to the neighbourhood
 *
 * @export
 * @enum {number}
 */
export enum NeighbourStatus {
  Unrecognised,
  Pairing,
  Recognised,
  Unstable,
  Stable,
}

/**
 * Maintains information about all other nodes in the network
 *
 * @export
 * @class Neighbourhood
 */
export class Neighbourhood {
  /**
   * Dictionary of neighbour nodes.
   *
   * @private
   * @type {{[reference: string]: Neighbour}}
   */
  private neighbours: { [reference: string]: Neighbour } = {};

  /**
   * Cache Object.Keys results of neigbours
   *
   * @private
   * @type {string[]}
   */
  private neighboursKeys: string[];

  /**
   * Additional ip lookup check
   *
   * @private
   * @type {{[reference: string]: boolean}}
   */
  private firewall: { [reference: string]: string } = {};

  /**
   * Count of how many neighbours (Reference Shortcut)
   *
   * @private
   * @type {Number}
   */
  private houses: number = 0;

  /**
   * Holds remaped references (Holds current to different)
   *
   * @static
   * @type {{ [index: string]: string }}
   */
  public static remapedAddr: { [index: string]: string };

  /**
   * Creates an instance of Neighbourhood and builds the list of
   * known neighbours
   */
  constructor() {
    // Temporary Access solution
    let neighbourhood: Array<any> = ActiveOptions.get("neighbourhood", false);

    // Any remapped references
    if (!Neighbourhood.remapedAddr) {
      Neighbourhood.remapedAddr = ActiveOptions.get("neighbourhoodRemap", {});
    }

    // Known Neighbours list (TODO have alternatives such a ledger based)
    // TODO make config interface
    if (!neighbourhood)
      throw ActiveLogger.fatal("Neighbourhood not found inside config");

    // Add Known Neighbours
    //this.add((config.neighbourhood as Neighbour[]));
    for (const neighbour of neighbourhood) {
      this.add(
        new Neighbour(
          neighbour.host,
          neighbour.port,
          false,
          new ActiveCrypto.KeyPair(
            neighbour.identity.type,
            neighbour.identity.public
          )
        )
      );
    }
  }

  /**
   * Add new neighbour to dictionary
   *
   * @param {Neighbour[]} neighbour
   */
  private add(neighbour: Neighbour): void;
  private add(neighbour: Neighbour[]): void;
  private add(neighbour: Neighbour | Neighbour[]): void {
    if (Array.isArray(neighbour)) {
      let i = neighbour.length;
      while (i--) {
        if (!this.neighbours[neighbour[i].reference]) {
          // Add to Neighbourhood
          this.neighbours[neighbour[i].reference] = neighbour[i];
          this.houses++;
          // Add IP to firewall
          this.firewall[neighbour[i].getAddress().host] = neighbour[i].reference;
          // Invert it for multi node hosting
          this.firewall[neighbour[i].reference] = neighbour[i].getAddress().host;
        } else {
          // Remove graceful (Being allow back in, Internal Refresh)
          this.neighbours[neighbour[i].reference].graceStop = false;
        }
      }
    } else {
      if (!this.neighbours[neighbour.reference]) {
        // Add to Neighbourhood
        this.neighbours[neighbour.reference] = neighbour;
        this.houses++;
        // Add IP to firewall
        this.firewall[neighbour.getAddress().host] = neighbour.reference;
        // Invert it for multi node hosting
        this.firewall[neighbour.reference] = neighbour.getAddress().host;
      } else {
        // Remove graceful (Being allow back in, Internal Refresh)
        this.neighbours[neighbour.reference].graceStop = false;
      }
    }
  }

  /**
   * Reset Neighbourhood
   *
   * @param {Neighbour[]} neighbours
   */
  public reset(neighbours: Array<any>): void {
    ActiveLogger.debug("Reload Request (Worker Resetting)");

    // Gracefully Shutdown Current Neighbours
    let keys = this.keys();
    for (const key of keys) {
      this.neighbours[key].graceStop = true;
    }

    // Add neighbours
    for (const neighbour of neighbours) {
      this.add(
        new Neighbour(
          neighbour.host,
          neighbour.port,
          false,
          new ActiveCrypto.KeyPair(
            neighbour.identity.type,
            neighbour.identity.public
          )
        )
      );
    }

    // Rebuild Object.keys cache
    this.neighboursKeys = Object.keys(this.neighbours);
  }

  /**
   * Get list of neighbours or randomly selected neighbour
   * Accessor error for public get
   *
   * @returns {({ [reference: string]: Neighbour })}
   */
  public get(): { [reference: string]: Neighbour };
  public get(reference: string): Neighbour;
  public get(random: boolean, skip?: Neighbour): Neighbour;
  public get(p1?: string | boolean, p2?: Neighbour): any {
    if (p1) {
      if (typeof p1 == "boolean") {
        const keys = this.keys();
        const getRandomNeighbour = () => this.neighbours[keys[(keys.length * Math.random()) << 0]];

        let neighbour = getRandomNeighbour();

        // If a neighbour to skip is provided, retry until we get a different one.
        // This is more efficient than copying and splicing the keys array.
        if (p2 && keys.length > 1) {
          while (neighbour.reference === p2.reference) {
            neighbour = getRandomNeighbour();
          }
        }

        // TODO: Add graceful stop handling if needed in the future.

        return neighbour;
      } else {
        if (this.neighbours[p1]) return this.neighbours[p1];
        return null;
      }
    } else {
      return this.neighbours;
    }
  }

  /**
   * Return Object.keys cache of neighbours
   *
   * @returns {string[]}
   */
  public keys(): string[] {
    if (!this.neighboursKeys) {
      this.neighboursKeys = Object.keys(this.neighbours);
    }
    return this.neighboursKeys;
  }

  /**
   * Check the client address is registered in the firewall
   *
   * @param {string} remote
   * @returns {boolean}
   */
  public checkFirewall(remote: string, nodeRef?: string): boolean {
    // IPv4 & IPv6 notation support
    if (remote.substr(0, 7) == "::ffff:") remote = remote.substr(7);
    if (nodeRef) {
      return this.firewall[remote] === nodeRef ? true : this.firewall[nodeRef] === remote
    } else {
      return this.firewall[remote] ? true : false
    }
  }

  /**
   * Checks the neighbourhood to see if this reference exists
   *
   * @param {string} reference
   * @returns {boolean}
   */
  public exists(reference: string): boolean {
    if (this.neighbours[reference]) {
      return true;
    }
    return false;
  }

  /**
   * Return the number of known neighbours
   *
   * @returns {number}
   */
  public count(): number {
    return this.houses;
  }

  /**
   * Knock all the neighbours who are home in the neighbourhood
   *
   * @param {string} endpoint
   * @param {*} [params]
   * @param {boolean} [force=false]
   * @returns {Promise<any>}
   */
  public knockAll(
    endpoint: string,
    params?: any,
    force: boolean = false
  ): Promise<any> {
    // Build up promises (Object.Entries may be better)
    const neighbourKeys = this.keys();

    const knocks = neighbourKeys
      .filter(key => force || this.neighbours[key].isHome)
      .map(key =>
        this.neighbours[key]
          .knock(endpoint, params)
          .then(response => response.data) // Pass over the data response on success
          .catch(e => {
            // On failure, resolve with an error object instead of rejecting the whole Promise.all
            ActiveLogger.debug(e, `Knock failed for ${key} during knockAll`);
            return { error: true, from: key };
          })
      );

    // Return all the promises at once
    return Promise.all(knocks);
  }
}
