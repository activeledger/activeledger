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
  Stable
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
   * @memberof Neighbourhood
   */
  private neighbours: { [reference: string]: Neighbour } = {};

  /**
   * Cache Object.Keys results of neigbours
   *
   * @private
   * @type {string[]}
   * @memberof Neighbourhood
   */
  private neighboursKeys: string[];

  /**
   * Additional ip lookup check
   *
   * @private
   * @type {{[reference: string]: boolean}}
   * @memberof Neighbourhood
   */
  private firewall: { [reference: string]: boolean } = {};

  /**
   * Count of how many neighbours (Reference Shortcut)
   *
   * @private
   * @type {Number}
   * @memberof Neighbourhood
   */
  private houses: number = 0;

  /**
   * Creates an instance of Neighbourhood and builds the list of
   * known neighbours
   * @memberof Neighbourhood
   */
  constructor() {
    // Temporary Access solution
    let neighbourhood: Array<any> = ActiveOptions.get("neighbourhood", false);

    // Known Neighbours list (TODO have alternatives such a ledger based)
    // TODO make config interface
    if (!neighbourhood)
      throw ActiveLogger.fatal("Neighbourhood not found inside config");

    // Add Known Neighbours
    //this.add((config.neighbourhood as Neighbour[]));
    let i = neighbourhood.length;
    while (i--) {
      this.add(
        new Neighbour(
          neighbourhood[i].host,
          neighbourhood[i].port,
          false,
          new ActiveCrypto.KeyPair(
            neighbourhood[i].identity.type,
            neighbourhood[i].identity.public
          )
        )
      );
    }
  }

  /**
   * Add new neighbour to dictionary
   *
   * @param {Neighbour[]} neighbour
   * @memberof Neighbourhood
   */
  private add(neighbour: Neighbour): void;
  private add(neighbour: Neighbour[]): void;
  private add(neighbour: any): void {
    if (Array.isArray(neighbour)) {
      let i = neighbour.length;
      while (i--) {
        if (!this.neighbours[neighbour[i].reference]) {
          // Add to Neighbourhood
          this.neighbours[neighbour[i].reference] = neighbour[i];
          this.houses++;
          // Add IP to firewall
          this.firewall[(neighbour[i] as Neighbour).getAddress().host] = true;
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
        this.firewall[(neighbour as Neighbour).getAddress().host] = true;
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
   * @memberof Neighbourhood
   */
  public reset(neighbours: Array<any>): void {
    ActiveLogger.debug("Reload Request (Worker Resetting)");

    // Gracefully Shutdown Current Neighbours
    let keys = this.keys();
    let i = keys.length;
    while (i--) {
      this.neighbours[keys[i]].graceStop = true;
    }

    // Add neighbours
    i = neighbours.length;
    while (i--) {
      this.add(
        new Neighbour(
          neighbours[i].host,
          neighbours[i].port,
          false,
          new ActiveCrypto.KeyPair(
            neighbours[i].identity.type,
            neighbours[i].identity.public
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
   * @memberof Neighbourhood
   */
  public get(): { [reference: string]: Neighbour };
  public get(reference: string): Neighbour;
  public get(random: boolean, skip?: Neighbour): Neighbour;
  public get(p1?: any, p2?: any): any {
    if (p1) {
      if (typeof p1 == "boolean") {
        // Get Keys as an array
        let keys = this.keys();

        // Are we removing a neighbour?
        if (p2) {
          let i = keys.length;
          while (i--) {
            if (keys[i] == p2.reference) {
              keys.splice(i, 1);
              break;
            }
          }
        }

        // Curently not in use, But will need to support graceful stop

        // Random with bitshift to select
        return this.neighbours[keys[(keys.length * Math.random()) << 0]];
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
   * @memberof Neighbourhood
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
   * @memberof Neighbourhood
   */
  public checkFirewall(remote: string): boolean {
    // IPv4 & IPv6 notation support
    if (remote.substr(0, 7) == "::ffff:") remote = remote.substr(7);
    return this.firewall[remote] || false;
  }

  /**
   * Checks the neighbourhood to see if this reference exists
   *
   * @param {string} reference
   * @returns {boolean}
   * @memberof Neighbourhood
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
   * @memberof Neighbourhood
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
   * @memberof Neighbourhood
   */
  public knockAll(
    endpoint: string,
    params?: any,
    force: boolean = false
  ): Promise<any> {
    // Build up promises (Object.Entries may be better)
    let neighbours = this.keys();

    // Loop each neighbour to get promise
    let i = neighbours.length;

    // Holds Promises
    let knocks: Promise<any>[] = [];

    while (i--) {
      if (force || this.neighbours[neighbours[i]].isHome)
        // While these could resolve before .all is called .alld does manage it
        knocks.push(
          new Promise((resolve, reject) => {
            // We want to catch all errors and only return the data
            this.neighbours[neighbours[i]]
              .knock(endpoint, params)
              .then(response => {
                // Pass over the data response
                resolve(response.data);
              })
              .catch(e => {
                // Do nothing with error (Don't want to interrupt)
                ActiveLogger.debug(e, "Knock All Single Knock Failure");
                resolve({ error: true });
              });
          })
        );
    }

    // Return all the promises at once
    return Promise.all(knocks);
  }
}
