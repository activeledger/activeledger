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
import { PostProcess, Activity } from "@activeledger/activecontracts";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Setup extends PostProcess {
  //#region Activeledger System Commands

  /**
   * Store System Configuration
   *
   * @private
   * @type {*}
   * @memberof Setup
   */
  private config: any;

  /**
   * Should we update the config post commit
   *
   * @private
   * @type {boolean}
   * @memberof Setup
   */
  private updateConfig: boolean = false;

  /**
   * Should we reload the config post commit
   *
   * @private
   * @type {boolean}
   * @memberof Setup
   */
  private reloadConfig: boolean = false;

  /**
   * Get System Configuration
   *
   * @param {any} config
   * @memberof Setup
   */
  public sysConfig(config: any) {
    this.config = config;
  }

  /**
   * Does the configuration need to reload
   *
   * @returns {boolean}
   * @memberof Setup
   */
  public configReload(): boolean {
    return this.reloadConfig;
  }

  //#endregion

  //#region Smart Contract Entry Points

  /**
   * Quick Check, Allow all data but make sure it is selfsigned
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "assert":
          this.assertVerify(selfsigned, resolve, reject);
          break;
        case "add":
          this.addNodeVerify(selfsigned, resolve, reject);
          break;
        case "remove":
          this.removeNodeVerify(selfsigned, resolve, reject);
          break;
        case "approve":
          this.approveNamespaceVerify(selfsigned, resolve, reject);
          break;
        case "revoke":
          this.revokeNamespaceVerify(selfsigned, resolve, reject);
          break;
        default:
          reject("unknown entry");
          break;
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "assert":
          this.assertVote(resolve, reject);
          break;
        case "add":
          this.addNodeVote(resolve, reject);
          break;
        case "remove":
          this.removeNodeVote(resolve, reject);
          break;
        case "approve":
          this.approveNamespaceVote(resolve, reject);
          break;
        case "revoke":
          this.revokeNamespaceVote(resolve, reject);
          break;
        default:
          reject("unknown entry");
          break;
      }
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "assert":
          this.assertCommit(resolve, reject);
          break;
        case "add":
          this.addNodeCommit(resolve, reject);
          break;
        case "remove":
          this.removeNodeCommit(resolve, reject);
          break;
        case "approve":
          this.approveNameCommit(resolve, reject);
          break;
        case "revoke":
          this.revokeNameCommit(resolve, reject);
          break;
        default:
          reject("unknown entry");
          break;
      }
    });
  }

  //#endregion

  //#region Assert Network to Ledger

  /**
   * Verify that this transaction meats assert requirements
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public assertVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.setup &&
        this.transactions.$i.setup.security &&
        this.transactions.$i.setup.consensus &&
        this.transactions.$i.setup.neighbourhood
      ) {
        resolve(true);
      } else {
        reject("Missing Assert Fields");
      }
    } else {
      // Will use the node configuration id's to verify
      reject("Must be self signed");
    }
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public assertVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Need to verify this exists
    let txNeighbourhood = this.transactions.$i.setup.neighbourhood;

    // Get Config neighbourhood
    let cngNeighbourhood = this.config.neighbourhood;

    // Check objects match
    if (this.deepArrayEq(txNeighbourhood, cngNeighbourhood)) {
      // Do we have a signature from one of these nodes

      // Breakout of typescript to access signature object
      // In a assert, Only 1 node needs to be signatory, However network object must match.
      let signatures = (this as any).sigs;
      let i = cngNeighbourhood.length;

      // Loop to find matching key (use host:port)
      while (i--) {
        let network = cngNeighbourhood[i];

        // Matching Signature?
        if (signatures[`${network.host}:${network.port}`]) {
          // Get Keypair via proxy (TODO: Fix definitions)
          let kp: any = new (this.ActiveCrypto.KeyPair as any)(
            network.identity.type,
            network.identity.public
          ) as any;

          // Check Signature
          if (
            kp.verify(
              this.transactions,
              signatures[`${network.host}:${network.port}`]
            )
          ) {
            // Found matching
            return resolve(true);
          } else {
            return reject("Found invalid node signature");
          }
        }
      }
    } else {
      reject("Network Neighborhood not matching");
    }
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public assertCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // We need to update the config now
    this.updateConfig = true;

    // Get new stream to hold this contract
    let setup = this.newActivityStream("contract.default.setup");

    // Get Stream state to manipulate
    let state = setup.getState();

    // Add Network Neighbourhood details
    state.neighbourhood = this.transactions.$i.setup.neighbourhood;

    // Add Security if exists (Only need to validate nodes)
    if (this.transactions.$i.setup.security)
      state.security = this.transactions.$i.setup.security;

    // Add Concensus
    if (this.transactions.$i.setup.consensus)
      state.consensus = this.transactions.$i.setup.consensus;

    // Do not need to add debug, host, db, rate, experimental
    // as these are node specifics.

    // Prepare for namespace import security (Check to see if blank)
    if (!state.security.namespace) state.security.namespace = {};

    // Additional Contract Locks?
    if (this.transactions.$i.setup.lock) {
      setup.setContractLock(this.transactions.$i.setup.lock);
    }

    // Add to Config
    this.config.network = setup.getName();

    // Save State
    setup.setState(state);
    resolve(true);
  }

  //#endregion

  //#region Add Node to Network

  /**
   * Do we have the right fields for an add node entry point
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public addNodeVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.node &&
        this.transactions.$i.node.identity &&
        this.transactions.$i.node.host &&
        this.transactions.$i.node.port
      ) {
        resolve(true);
      } else {
        reject("Missing Add Node Fields");
      }
    } else {
      // Will use the node configuration id's to verify
      reject("Must be self signed");
    }
  }

  /**
   * Do we have the right permissions to continue adding a node
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public addNodeVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (this.verifySelfSignedTx()) {
      // Verify node doesn't already exist
      // Get Config neighbourhood
      let cngNeighbourhood = this.config.neighbourhood;
      let i = cngNeighbourhood.length;

      while (i--) {
        let neighbour = cngNeighbourhood[i];
        if (neighbour.host == this.transactions.$i.node.host) {
          reject("Node already exists");
        }
      }
      resolve(true);
    } else {
      reject("Host node signature problem");
    }
  }

  /**
   * Add the node to the network stream
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public addNodeCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let activity = this.getActivityStreams(stream);
    let network = activity.getState();

    // Add Node to list
    network.neighbourhood.push(this.transactions.$i.node);

    // Tell Activeledger to update
    this.reloadConfig = true;

    resolve(true);
  }

  //#endregion

  //#region Remove Node from Network

  /**
   * Do we have the right fields for node removal entry point
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public removeNodeVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.node &&
        this.transactions.$i.node.identity &&
        this.transactions.$i.node.host &&
        this.transactions.$i.node.port
      ) {
        resolve(true);
      } else {
        reject("Missing Add Node Fields");
      }
    } else {
      // Will use the node configuration id's to verify
      reject("Must be self signed");
    }
  }

  /**
   * Do we have the right permissions to continue removing a node
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public removeNodeVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (this.verifySelfSignedTx()) {
      // Verify node already exists
      // Get Config neighbourhood
      let cngNeighbourhood = this.config.neighbourhood;
      let i = cngNeighbourhood.length;

      while (i--) {
        let neighbour = cngNeighbourhood[i];
        if (neighbour.host == this.transactions.$i.node.host) {
          resolve(true);
        }
      }
      reject("Node doesn't exist");
    } else {
      reject("Host node signature problem");
    }
  }

  /**
   * Remove node from ledger
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @memberof Setup
   */
  public removeNodeCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let activity = this.getActivityStreams(stream);
    let network = activity.getState();

    // Create new list remove the one
    let nodes = [];
    let i = network.neighbourhood.length;

    while (i--) {
      let neighbour = network.neighbourhood[i];
      if (neighbour.host != this.transactions.$i.node.host) {
        nodes.push(neighbour);
      }
    }    
    // Rebuild list
    network.neighbourhood = nodes;

    // Tell Activeledger to update
    this.reloadConfig = true;

    resolve(true);
  }

  //#endregion

  //#region Approve Namespace Import Rules

  public approveNamespaceVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  public approveNamespaceVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  public approveNameCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  //#endregion

  //#region Revoke Namespace Import Rules

  public revokeNamespaceVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  public revokeNamespaceVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  public revokeNameCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {}

  //#endregion

  /**
   * Process configuration file updates
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof Setup
   */
  public postProcess(territoriality: boolean, who: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.updateConfig) {
        // Backup config (TODO What if this isn't the config file?)
        fs.copyFileSync(
          this.config.__filename,
          this.config.__filename + ".bak"
        );
        // Remove properties now in the ledger
        delete this.config.neighbourhood;
        delete this.config.consensus;
        delete this.config.security;
        // Cache then Remove Filename
        let config = this.config.__filename;
        delete this.config.__filename;
        // Write new config
        fs.writeFileSync(config, JSON.stringify(this.config));
        resolve(true);
      } else {
        resolve(true);
      }
    });
  }

  //#region Helper functions

  /**
   * Verify Signatures of Host Nodes
   *
   * @private
   * @returns {boolean}
   * @memberof Setup
   */
  private verifySelfSignedTx(): boolean {
    // Get Config neighbourhood
    let cngNeighbourhood = this.config.neighbourhood;

    // Extract Signatures from transaction
    let signatures = (this as any).sigs;
    let sigKeys = Object.keys(signatures);

    // Quick check, Do we have more than half the signatures?
    // Remember we need to remove 1 for the self signed
    if (sigKeys.length - 1 > cngNeighbourhood.length / 2) {
      // Now need to verify the signatures are valid and are from different nodes
      let i = cngNeighbourhood.length;

      // Loop to find matching key (use host:port)
      while (i--) {
        let network = cngNeighbourhood[i];

        // Matching Signature?
        if (signatures[`${network.host}:${network.port}`]) {
          // Get Keypair via proxy (TODO: Fix definitions)
          let kp: any = new (this.ActiveCrypto.KeyPair as any)(
            network.identity.type,
            network.identity.public
          ) as any;

          // Check Signature
          if (
            !kp.verify(
              this.transactions,
              signatures[`${network.host}:${network.port}`]
            )
          ) {
            return false;
          }
        }
      }
      // All Matching & Different Node Signatures
      return true;
    } else {
      return false;
    }
  }

  /**
   * Navigate 2 arrays of objects and compare
   *
   * @private
   * @param {Array<any>} a
   * @param {Array<any>} b
   * @returns {boolean}
   * @memberof Setup
   */
  private deepArrayEq(a: Array<any>, b: Array<any>): boolean {
    // First check the lengths match
    if (a.length == b.length) {
      // Loop a and verify in b, Order check not important
      let i = a.length;
      // prepare the return
      let results: boolean = true;
      while (i--) {
        if (!this.arrayEq(a[i], b)) {
          return false;
        }
      }
      // Got here it must match!
      return true;
    } else {
      return false;
    }
  }

  /**
   * Check specific object exists inside an array
   *
   * @private
   * @param {*} a
   * @param {Array<any>} b
   * @returns {boolean}
   * @memberof Setup
   */
  private arrayEq(a: any, b: Array<any>): boolean {
    // String comparrsion check cache
    let compare = JSON.stringify(a);
    // Loop b to see if a exists
    let i = b.length;
    while (i--) {
      if (JSON.stringify(b[i]) == compare) {
        return true;
      }
    }
    // Got here not matching
    return false;
  }

  /**
   * Compares two objects to see if they match
   *
   * @private
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   * @memberof Setup
   * @author atmin {stackoveflow}
   */
  private deepEq(a: any, b: any): boolean {
    const ok = Object.keys,
      ta = typeof a,
      tb = typeof b;
    return a && b && ta === "object" && ta === tb
      ? ok(a).length === ok(a).length &&
          ok(b).every(key => this.deepEq(a[key], b[key]))
      : a === b;
  }
  //#endregion
}
