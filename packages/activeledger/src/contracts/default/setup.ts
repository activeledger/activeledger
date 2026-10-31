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
import { PostProcess, ActiveCrypto } from "@activeledger/activecontracts";
import { ActiveOptions, HybridConfig } from "@activeledger/activeoptions";

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
   */
  private config: any;

  /**
   * Should we update the config post commit
   *
   * @private
   * @type {boolean}
   */
  private updateConfig: boolean = false;

  /**
   * Should we reload the config post commit
   *
   * @private
   * @type {boolean}
   */
  private reloadConfig: boolean = false;

  /**
   * Build level from which an assert also copies the `hybrid` section into
   * the setup stream. Below it the asserted state stays byte-for-byte what
   * earlier releases wrote, so a half-upgraded network cannot diverge on it.
   *
   * @private
   * @static
   */
  private static readonly HYBRID_BUILD = 40300;

  /**
   * Was the hybrid section asserted to the ledger by this transaction
   *
   * @private
   * @type {boolean}
   */
  private assertedHybrid: boolean = false;

  /**
   * Get System Configuration
   *
   * @param {any} config
   */
  public sysConfig(config: any) {
    this.config = config;
  }

  /**
   * Does the configuration need to reload
   *
   * @returns {boolean}
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
        case "hybrid":
          this.hybridVerify(selfsigned, resolve, reject);
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
        case "hybrid":
          this.hybridVote(resolve, reject);
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
          this.approveNamespaceCommit(resolve, reject);
          break;
        case "revoke":
          this.revokeNamespaceCommit(resolve, reject);
          break;
        case "hybrid":
          this.hybridCommit(resolve, reject);
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
        // Optional hybrid section, validated strictly once supported
        if (this.assertsHybrid()) {
          const invalid = HybridConfig.validate(
            this.transactions.$i.setup.hybrid
          );
          if (invalid) return reject(invalid);
        }
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
          let kp: any = new (ActiveCrypto.KeyPair as any)(
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

      // None of the configured nodes signed
      reject("Host node signature problem");
    } else {
      reject("Network Neighborhood not matching");
    }
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
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

    // Add Hybrid rules (validated in verify)
    if (this.assertsHybrid()) {
      state.hybrid = this.transactions.$i.setup.hybrid;
      this.assertedHybrid = true;
    }

    // Do not need to add debug, host, db, rate, experimental
    // as these are node specifics.

    // Prepare for namespace import security (Check to see if blank)
    if (!state.security.namespace) state.security.namespace = {};

    // Additional Contract Locks?
    if (this.transactions.$i.setup.lock) {
      setup.setContractLock([this.transactions.$i.setup.lock, "setup"]);
    } else {
      setup.setContractLock("setup");
    }

    // Add to Config (Extract )
    this.config.network = setup.getName() + "@assertion";

    // Save State
    setup.setState(state);

    // Are we locking
    if (this.transactions.$i.setup.security.lock) {
      setup.setContractLock(this.transactions.$i.setup.security.lock);
    }

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
   */
  public addNodeVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.suggester &&
        this.transactions.$i.suggester.identity &&
        this.transactions.$i.suggester.host &&
        this.transactions.$i.suggester.port
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
        if (
          neighbour.host + ":" + neighbour.port ==
          this.transactions.$i.suggester.host +
            ":" +
            this.transactions.$i.suggester.port
        ) {
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
    network.neighbourhood.push(this.transactions.$i.suggester);

    // Set Activity State
    activity.setState(network);

    // Tell Activeledger to update
    this.reloadConfig = true;

    // Reset network, With _rev extraction
    this.config.network =
      activity.getName() + "@" + (activity as any).state._rev;
    this.updateConfig = true;

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
   */
  public removeNodeVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.suggester &&
        this.transactions.$i.suggester.identity &&
        this.transactions.$i.suggester.host &&
        this.transactions.$i.suggester.port
      ) {
        resolve(true);
      } else {
        reject("Missing Remove Node Fields");
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
   */
  public removeNodeVote(
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
        if (
          neighbour.host + ":" + neighbour.port ==
          this.transactions.$i.suggester.host +
            ":" +
            this.transactions.$i.suggester.port
        ) {
          resolve(true);
        }
      }
      reject("Node doesn't exists");
    } else {
      reject("Host node signature problem");
    }
  }

  /**
   * Remove node from ledger
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
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
    let nodes: any[] = [];
    let i = network.neighbourhood.length;

    while (i--) {
      let neighbour = network.neighbourhood[i];
      if (
        neighbour.host + ":" + neighbour.port !=
        this.transactions.$i.suggester.host +
          ":" +
          this.transactions.$i.suggester.port
      ) {
        nodes.push(neighbour);
      }
    }
    // Rebuild list
    network.neighbourhood = nodes;

    // Set Activity State
    activity.setState(network);

    // Tell Activeledger to update
    this.reloadConfig = true;

    // Reset network, With _rev extraction
    this.config.network =
      activity.getName() + "@" + (activity as any).state._rev;
    this.updateConfig = true;

    resolve(true);
  }

  //#endregion

  //#region Approve Namespace Import Rules

  /**
   * Make sure the transaction is valid for managing namespaces
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   * @returns {void}
   */
  public approveNamespaceVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.suggester &&
        this.transactions.$i.suggester.namespace &&
        this.transactions.$i.suggester.libs
      ) {
        // NPM Check
        if (this.transactions.$i.suggester.libs.npm) {
          return reject("NPM libraries not supported yet");
        }
        // Node Standard Check
        if (!this.transactions.$i.suggester.libs.std) {
          return reject("Only support standard libraries");
        }
        resolve(true);
      } else {
        reject("Missing Approve Namespace Fields");
      }
    } else {
      // Will use the node configuration id's to verify
      reject("Must be self signed");
    }
  }

  /**
   * Voting round to make sure we like the transaction for managing namespaces
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public approveNamespaceVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (this.verifySelfSignedTx()) {
      // Make sure array is string only
      this.convertArray(this.transactions.$i.suggester.libs.std).forEach(
        item => {
          if (typeof item !== "string") return reject("Invalid Standard Input");
        }
      );
      resolve(true);
    } else {
      reject("Host node signature problem");
    }
  }

  /**
   * Commit the new namespace options
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public approveNamespaceCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let activity = this.getActivityStreams(stream);
    let network = activity.getState();

    // Update allowed namespaces
    network.security.namespace[this.transactions.$i.suggester.namespace] = {
      std: this.convertArray(this.transactions.$i.suggester.libs.std),
      npm: []
    };

    // Set Activity State
    activity.setState(network);

    // Tell Activeledger to update
    this.reloadConfig = true;

    // Reset network, With _rev extraction
    this.config.network =
      activity.getName() + "@" + (activity as any).state._rev;
    this.updateConfig = true;

    resolve(true);
  }

  //#endregion

  //#region Revoke Namespace Import Rules

  /**
   * Make sure the transaction is valid for revoking namespaces
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public revokeNamespaceVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (selfsigned) {
      // Required Inputs
      if (
        this.transactions.$i.suggester &&
        this.transactions.$i.suggester.namespace
      ) {
        resolve(true);
      } else {
        reject("Missing Revoke Namespace Fields");
      }
    } else {
      // Will use the node configuration id's to verify
      reject("Must be self signed");
    }
  }

  /**
   * Standard self-signed voting round
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public revokeNamespaceVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (this.verifySelfSignedTx()) {
      // Nothing else to check
      resolve(true);
    } else {
      reject("Host node signature problem");
    }
  }

  /**
   * Commit the revoked namespace
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public revokeNamespaceCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let activity = this.getActivityStreams(stream);
    let network = activity.getState();

    // Remove from namespace
    delete network.security.namespace[this.transactions.$i.suggester.namespace];

    // Set Activity State
    activity.setState(network);

    // Tell Activeledger to update
    this.reloadConfig = true;

    // Reset network, With _rev extraction
    this.config.network =
      activity.getName() + "@" + (activity as any).state._rev;
    this.updateConfig = true;

    resolve(true);
  }

  //#endregion

  //#region Change Hybrid Rules

  /**
   * Apply a change to the hybrid section. Changes are operations rather than
   * a replacement so two operators cannot overwrite each other:
   * `{ admission?: "open" | "allowlist", allow?: [key], deny?: [key], minVersion?: semver }`
   * Keys are public keys or their key hashes.
   *
   * @private
   * @static
   * @param {*} current The hybrid section now on the ledger
   * @param {*} change
   * @returns {{ hybrid?: any; error?: string }}
   */
  private static applyHybrid(
    current: any,
    change: any
  ): { hybrid?: any; error?: string } {
    if (!HybridConfig.isSection(current)) {
      return { error: "Network has no hybrid section" };
    }
    if (
      !change ||
      typeof change !== "object" ||
      Array.isArray(change) ||
      Object.keys(change).some(
        (k) => ["admission", "allow", "deny", "minVersion"].indexOf(k) === -1
      )
    ) {
      return { error: "Unknown hybrid change" };
    }
    const hybrid = JSON.parse(JSON.stringify(current));

    if (change.admission !== undefined) {
      if (change.admission === "open") {
        hybrid.admission = "open";
      } else if (change.admission === "allowlist") {
        // Opening an allowlist keeps what is already on it
        if (hybrid.admission === "open") hybrid.admission = { allowlist: [] };
      } else {
        return { error: 'admission must be "open" or "allowlist"' };
      }
    }

    const keys = (value: any): string[] | null =>
      Array.isArray(value) &&
      value.every((k: any) => typeof k === "string" && k.length > 0)
        ? value
        : null;

    for (const op of ["allow", "deny"]) {
      if (change[op] === undefined) continue;
      const list = keys(change[op]);
      if (!list) return { error: `${op} must be a list of keys` };
      if (hybrid.admission === "open") {
        return { error: `Admission is open, there is no allowlist to ${op}` };
      }
      const hashed = (k: string) =>
        k.indexOf("-----") === -1 ? k : ActiveCrypto.keyHash(k);
      const entries: string[] = hybrid.admission.allowlist;
      if (op === "allow") {
        const held = entries.map(hashed);
        for (const key of list) {
          if (held.indexOf(hashed(key)) === -1) entries.push(key);
        }
      } else {
        const gone = list.map(hashed);
        hybrid.admission.allowlist = entries.filter(
          (e) => gone.indexOf(hashed(e)) === -1
        );
      }
    }

    if (change.minVersion !== undefined) hybrid.minVersion = change.minVersion;

    const invalid = HybridConfig.validate(hybrid);
    return invalid ? { error: invalid } : { hybrid };
  }

  /**
   * The same shape check as the other majority-signed entries
   *
   * @param {boolean} selfsigned
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public hybridVerify(
    selfsigned: boolean,
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    if (!selfsigned) return reject("Must be self signed");
    if (ActiveOptions.get<number>("build", 0) < Setup.HYBRID_BUILD) {
      return reject("Hybrid changes need build " + Setup.HYBRID_BUILD);
    }
    if (!this.transactions.$i.suggester?.change) {
      return reject("Missing Hybrid Change Fields");
    }
    // Checked against the stream's own section at commit; here a stand-in
    // that only tests the change itself
    const { error } = Setup.applyHybrid(
      {
        admission: { allowlist: [] },
        required: [],
        window: { days: 1 },
        minVersion: "0.0.0",
      },
      this.transactions.$i.suggester.change
    );
    error ? reject(error) : resolve(true);
  }

  /**
   * A majority of the nodes must have signed
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public hybridVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Unlike the older entries, count only valid signatures from distinct
    // configured nodes: padding $sigs with other keys must not reach a majority
    if (!this.verifyMajoritySigned()) {
      return reject("Host node signature problem");
    }
    // The change is for the network's own setup stream and nothing else
    const outputs = Object.keys(this.transactions.$o || {});
    const stream = String(this.config.network || "").split("@")[0];
    if (outputs.length !== 1 || !stream || outputs[0] !== stream) {
      return reject("Not the network setup stream");
    }
    resolve(true);
  }

  /**
   * True when more than half of the configured nodes have a valid signature
   * over the transaction
   *
   * @private
   * @returns {boolean}
   */
  private verifyMajoritySigned(): boolean {
    const neighbourhood: any[] = this.config.neighbourhood || [];
    const signatures = (this as any).sigs || {};
    let valid = 0;
    const seen = new Set<string>();
    for (const network of neighbourhood) {
      const name = `${network.host}:${network.port}`;
      if (seen.has(name) || typeof signatures[name] !== "string") continue;
      seen.add(name);
      try {
        const kp: any = new (ActiveCrypto.KeyPair as any)(
          network.identity.type,
          network.identity.public
        );
        if (kp.verify(this.transactions, signatures[name])) valid++;
      } catch {
        // An unusable signature is not a vote
      }
    }
    return valid > neighbourhood.length / 2;
  }

  /**
   * Put the changed section into the setup stream
   *
   * @param {((value?: boolean | PromiseLike<boolean> | undefined) => void)} resolve
   * @param {(reason?: any) => void} reject
   */
  public hybridCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    const stream = Object.keys(this.transactions.$o)[0];
    const activity = this.getActivityStreams(stream);
    const network = activity.getState();

    const { hybrid, error } = Setup.applyHybrid(
      network.hybrid,
      this.transactions.$i.suggester.change
    );
    if (error) return reject(error);
    network.hybrid = hybrid;
    activity.setState(network);

    this.reloadConfig = true;
    this.config.network =
      activity.getName() + "@" + (activity as any).state._rev;
    this.updateConfig = true;
    // Like assert: the section lives on the ledger, not in the config file
    this.assertedHybrid = true;

    resolve(true);
  }

  //#endregion

  /**
   * Process configuration file updates
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
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
        if (this.assertedHybrid) delete this.config.hybrid;
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
   * Does this assert carry a hybrid section to put on the ledger. The legacy
   * `hybrid: []` URL list is not a section and is never asserted.
   *
   * @private
   * @returns {boolean}
   */
  private assertsHybrid(): boolean {
    return (
      ActiveOptions.get<number>("build", 0) >= Setup.HYBRID_BUILD &&
      this.transactions.$i.setup.hybrid !== undefined &&
      !Array.isArray(this.transactions.$i.setup.hybrid)
    );
  }

  /**
   * Verify Signatures of Host Nodes
   *
   * @private
   * @returns {boolean}
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
          let kp: any = new (ActiveCrypto.KeyPair as any)(
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

  /**
   * Make sure the input is an array of sorts
   *
   * @private
   * @param {string} input
   * @returns {Array<string>}
   */
  private convertArray(input: string): Array<string>;
  private convertArray(input: string[]): Array<string>;
  private convertArray(input: unknown): any {
    // Basic shallow check
    if (Array.isArray(input)) return input;

    // Convert string to array
    if (typeof input === "string") return [input];

    // If something else blank array
    return [];
  }

  //#endregion
}
