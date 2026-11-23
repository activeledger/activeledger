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
import { ChildProcess } from "child_process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Neighbour } from "./neighbour";
import { Neighbourhood, NeighbourStatus } from "./neighbourhood";
import { ActiveInterfaces } from "./utils";
/**
 * Which of `refs` (the sorted references of the active nodes) owns a stream:
 * the hash of the stream id picks one, so every node with the same list
 * picks the same node.
 */
export function ownerOf(streamId: string, refs: string[]): string | undefined {
  if (!refs || !refs.length) return undefined;
  return refs[parseInt(ActiveCrypto.Hash.getHash(streamId).slice(0, 8), 16) % refs.length];
}

const STREAM_ID = /^[0-9a-f]{64}$/;

/**
 * Every stream a transaction could be writing, under every reading of its
 * $i and $o that the host's locking and the protocol use: a label standing in
 * for the stream in its $stream (the protocol only does this when the FIRST
 * entry is labelled, the host does it per entry), ids longer than 64 trimmed
 * from the front. A transaction is only a leader candidate if the whole set is
 * well formed; anything odd (not a 64 character id, a $stream that is not a
 * string, an entry that is not an object) returns undefined, and it is a
 * normal transaction. Taking the union means a transaction cannot be read one
 * way for ownership and another for the write.
 */
export function leaderStreams(tx: any): string[] | undefined {
  const found = new Set<string>();
  const add = (id: unknown): boolean => {
    if (typeof id !== "string") return false;
    const trimmed = id.length > 64 ? id.slice(-64) : id;
    if (!STREAM_ID.test(trimmed)) return false;
    found.add(trimmed);
    return true;
  };
  for (const io of [tx?.$tx?.$i, tx?.$tx?.$o]) {
    if (io === undefined || io === null) continue;
    if (typeof io !== "object") return undefined;
    const keys = Object.keys(io);
    let firstLabelled = false;
    for (let i = 0; i < keys.length; i++) {
      const value = io[keys[i]];
      if (!value || typeof value !== "object") return undefined;
      if (value.$stream && typeof value.$stream !== "string") return undefined;
      const labelled = !!value.$stream;
      if (i === 0) firstLabelled = labelled;
      // The host's reading: the label when there is one
      if (!add(labelled ? value.$stream : keys[i])) return undefined;
      // The protocol's reading: labels only count when the first entry has one
      if (!firstLabelled && !add(keys[i])) return undefined;
    }
  }
  return found.size ? [...found] : undefined;
}

/**
 * Should a node honour the entry node's leader mark? Only if this node, from
 * its own list of nodes, agrees that the entry node owns everything written.
 */
export function leaderMarkHolds(tx: any, origin: string | undefined, refs: string[]): boolean {
  const streams = leaderStreams(tx);
  return !!streams && !!origin && leaderOwnerOf(streams, refs) === origin;
}

/** The one node that owns all of the streams, or undefined if there is none */
export function leaderOwnerOf(streamIds: string[], refs: string[]): string | undefined {
  if (!streamIds || !streamIds.length) return undefined;
  const owner = ownerOf(streamIds[0], refs);
  for (let i = 1; i < streamIds.length; i++) {
    if (ownerOf(streamIds[i], refs) !== owner) return undefined;
  }
  return owner;
}

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
   */
  public neighbourhood: Neighbourhood = new Neighbourhood();

  /**
   * This nodes identity signing authority, Cannot be readonly
   * with this post identity build assign method.
   *
   * @static
   * @type {ActiveCrypto.KeyPair}
   */
  public static identity: ActiveCrypto.KeyPair;

  /**
   * Cache public pem string for exposing
   *
   * @static
   * @type {string}
   */
  public static publicPem: string;

  /**
   * Node to the left of our Home
   *
   * @static
   * @type {Neighbour}
   */
  public static left: Neighbour;

  /**
   * Node to the right of our Home
   *
   * @static
   * @type {Neighbour}
   */
  public static right: Neighbour;

  /**
   * Also need global scope for this host home node reference
   *
   * @static
   * @type {string}
   */
  public static reference: string;

  /**
   * Also need global scope for this host location details
   *
   * @static
   * @type {string}
   */
  public static host: string;

  /**
   * Holds the territoriality map
   *
   * @private
   * @type {string[]}
   */
  protected tMap: string[];

  /**
   * Holds the Transactions Processors
   *
   * @protected
   * @type {ChildProcess[]}
   */
  protected processors: ChildProcess[] = [];

  /**
   * Process ready to be hot swapped
   *
   * @private
   * @type {ChildProcess}
   */
  protected standbyProcess: ChildProcess;

  /**
   * Iterator for looping processors
   *
   * @protected
   * @type {IterableIterator<ChildProcess>}
   */
  protected processorIterator: IterableIterator<ChildProcess>;

  /**
   * Creates an instance of Home.
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

    // Has this address reference been remapped out
    if (
      Neighbourhood.remapedAddr &&
      Neighbourhood.remapedAddr[this.reference]
    ) {
      Home.reference = this.reference =
        Neighbourhood.remapedAddr[this.reference];
    }

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
   * @param {boolean} [signed=false]
   * @returns {(string | null)}
   */
  public static sign(data: string, signed: boolean = false): string | null {
    if (signed || ActiveOptions.get<any>("security", {}).signedConsensus) {
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
   */
  public decrypt(data: any): any {
    return Home.identity.decrypt(data);
  }

  /**
   * Gets the current host home status
   *
   * @returns {NeighbourStatus}
   */
  public getStatus(): NeighbourStatus {
    // Only Connected to itself
    if (
      this.reference == Home.right.reference &&
      this.reference == Home.left.reference
    ) {
      // Single Node Network
      if (this.neighbourhood.count() == 1) {
        return NeighbourStatus.Stable;
      }
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
   */
  public terriBuildMap(): void {
    // Get all active neighbours, map to their references, and sort them.
    // This creates a deterministic order for territoriality calculations.
    this.tMap = Object.values(this.neighbourhood.get())
      .filter((neighbour) => !neighbour.graceStop)
      .map((neighbour) => neighbour.reference)
      .sort((a, b) => {
        if (a > b) return 1;
        if (a < b) return -1;
        return 0;
      });
  }

  /**
   * The node that owns every one of these streams for leader mode, or
   * undefined when there is no single owner (no streams, or they belong to
   * different nodes). Leader mode skips the vote, so only one node may lead
   * writes to a stream or two leaders could commit different transactions at
   * the same revision.
   *
   * @param {string[]} streamIds
   * @returns {(string | undefined)}
   */
  public leaderOwner(streamIds: string[]): string | undefined {
    return leaderOwnerOf(streamIds, this.tMap);
  }

  /**
   * Return which entry node is needed for the commit to happen where
   * this assumes all nodes will vote yes
   *
   * @param {string} commitAt
   * @returns {string}
   */
  public terriMap(commitAt: string): string {
    // How many votes are needed for consesus
    let votes = Math.ceil(
      (ActiveOptions.get<any>("consensus", {}).reached / 100) * this.tMap.length
    );

    // Find the position of the target commit node in the sorted map.
    let commitPos = this.tMap.indexOf(commitAt);

    // Make sure it exists
    if (commitPos !== -1) {
      // Calculate the entry node's position by counting backwards from the commit node.
      // The +1 accounts for the entry node itself being part of the consensus group.
      let sendPos = commitPos - votes + 1;

      // Handle wrap-around for the circular network topology.
      if (sendPos >= 0) {
        return this.tMap[sendPos];
      } else {
        // If the index is negative, wrap around from the end of the array.
        return this.tMap.slice(sendPos)[0];
      }
    }

    // Blank string for unknown
    return "";
  }

  /**
   * Sets up this homes immediate neighbours
   *
   * @param {string | null} left
   * @param {string | null} right
   * @returns {void}
   */
  public setNeighbours(left: string | null, right: string | null): void {
    // Check to make sure this is a new neighbour
    if (right) this.setRight(right);
    if (left) this.setLeft(left);
  }

  /**
   * Sets its right neighbour
   *
   * @param {Neighbour} right
   */
  public setRight(right: string): void {
    if (right) {
      // Set for this process
      const neighbour = this.neighbourhood.get(right);
      if (!neighbour) {
        ActiveLogger.warn(`[AC] - Right neighbour ${right} not found in neighbourhood map yet`);
        return;
      }

      Home.right = neighbour;

      // Still able to connect or shutdowning from the network?
      if (Home.right && !Home.right.graceStop) {
        // We know isHome
        Home.right.setState("home");
      } else {
        Home.right = new Neighbour(this.host, this.port);
      }

      // Update Sub Processes
      const hkMsg = {
        type: "hk",
        data: {
          right: {
            host: Home.right.host,
            port: Home.right.port,
            reference: Home.right.reference,
            isHome: Home.right.isHome,
            graceStop: Home.right.graceStop,
            identity: Home.right.identity
          },
        },
      };
      this.processors.forEach((processor) => {
        processor.send(hkMsg);
      });

      // Also Send to the standby
      this.standbyProcess.send(hkMsg);
    }
  }

  /**
   * Sets its left neighbour
   *
   * @param {Neighbour} left
   */
  public setLeft(left: string): void {
    if (left) {
      // Set for this process
      const neighbour = this.neighbourhood.get(left);
      if (!neighbour) {
        ActiveLogger.warn(`[AC] - Left neighbour ${left} not found in neighbourhood map yet`);
        return;
      }

      Home.left = neighbour;

      // Still able to connect or shutdowning from the network?
      if (Home.left && !Home.left.graceStop) {
        // We know isHome
        Home.left.setState("home");
      } else {
        Home.left = new Neighbour(this.host, this.port);
      }
    }
  }

  /**
   * Find Process by pid
   *
   * @param {number} pid
   * @returns {ChildProcess}
   */
  public findProcessor(pid: number): ChildProcess | undefined {
    return this.processors.find((processor) => {
      if (!processor.killed) {
        return processor.pid === pid ? true : false;
      }
    }) as ChildProcess;
  }
}
