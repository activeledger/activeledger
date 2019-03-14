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

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveLogger as DefaultActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto as DefaultActiveCrypto } from "@activeledger/activecrypto";

/**
 * Stream management class. This will control ACL and permissions for activeledger
 *
 * @export
 * @class Stream
 */
export class Stream {
  /**
   * Holds all the activity streams in this trasnaction
   *
   * @private
   * @type {{ [reference: string]: Activity }}
   * @memberof Stream
   */
  private activities: { [reference: string]: Activity } = {};

  /**
   * Storage of outbound INC data
   *
   * @private
   * @type {Object}
   * @memberof Stream
   */
  private outINC: Object;

  /**
   * Are we throwing this transaction to another ledger
   *
   * @private
   * @type {string}
   * @memberof Stream
   */
  public throwTo: string[];

  /**
   * When does this contract want to timeout
   *
   * @private
   * @type {date}
   * @memberof Stream
   */
  private nextTimeout: Date;

  /**
   * Post decryption, Safe mode tries to ensure total network
   * consensus. Disabling it is dangerous but can be used correctly.
   *
   * @private
   * @type {boolean}
   * @memberof Stream
   */
  private safeMode: boolean = false;

  /**
   * Creates an instance of a Standard Activeledger Contract.
   *
   * @param {Date} cDate
   * @param {string} umid
   * @param {ActiveDefinitions.LedgerTransaction} transactions
   * @param {ActiveDefinitions.LedgerStream[]} inputs
   * @param {ActiveDefinitions.LedgerStream[]} outputs
   * @param {ActiveDefinitions.LedgerIORputs} reads
   * @param {ActiveDefinitions.LedgerSignatures} sigs
   * @param {number} key
   * @param {string} selfHost
   * @memberof Stream
   */
  constructor(
    protected cDate: Date,
    protected umid: string,
    protected transactions: ActiveDefinitions.LedgerTransaction,
    private inputs: ActiveDefinitions.LedgerStream[],
    private outputs: ActiveDefinitions.LedgerStream[],
    private reads: ActiveDefinitions.LedgerIORputs,
    private sigs: ActiveDefinitions.LedgerSignatures,
    private key: number,
    private selfHost: string
  ) {
    // Input Steam Activities
    let i: number = this.inputs.length;
    while (i--) {
      this.activities[this.inputs[i].state._id as string] = new Activity(
        null,
        null,
        (this.inputs[i].state._id as string) in this.sigs,
        this.inputs[i].meta,
        this.inputs[i].state,
        this.inputs[i].volatile
      );

      // Set Secret Key
      this.activities[this.inputs[i].state._id as string].setKey(this.key);
    }

    // Output Steam Activities
    i = this.outputs.length;
    while (i--) {
      this.activities[this.outputs[i].state._id as string] = new Activity(
        null,
        null,
        false,
        this.outputs[i].meta,
        this.outputs[i].state,
        this.outputs[i].volatile
      );

      // Set Secret Key
      this.activities[this.outputs[i].state._id as string].setKey(this.key);
    }
  }

  /**
   * Attempts to decrypt data with possible known private keys
   *
   * @param {(ActiveCrypto.ISecuredData | {})} data
   * @param {boolean} [safeMode=true]
   * @returns {Promise<{}>}
   * @memberof Stream
   */
  public attemptDecrypt(
    data: DefaultActiveCrypto.ISecuredData | {},
    safeMode = true
  ): Promise<{}> {
    return new Promise((resolve, reject) => {
      // Safemode being enabled?
      if (safeMode) {
        // Set safemode
        this.safeMode = safeMode;

        // Loop all activities and set safemode
        let keys = Object.keys(this.activities);
        let i = keys.length;
        while (i--) {
          this.activities[keys[i]].setSafeMode();
        }
      }

      // Run Decryption (On success return only data)
      ActiveCrypto.Secured.decrypt(data as DefaultActiveCrypto.ISecuredData)
        .then((results: any) => {
          resolve(results.data);
        })
        .catch(reject);
    });
  }

  /**
   * Create new activity stream
   *
   * @param {string} name
   * @param {string} [deterministic]
   * @returns {Activity}
   * @memberof Stream
   */
  public newActivityStream(name: string, deterministic?: string): Activity {
    if (this.safeMode) {
      throw new Error("Cannot create new Activity stream in Safe Mode");
    } else {
      // Create new activity
      let activity = new Activity(
        deterministic ? deterministic : this.umid,
        name,
        false
      );
      // Set Secret Key
      activity.setKey(this.key);
      // TODO: Convert name into a umid string and alert dev
      return (this.activities[name] = activity);
    }
  }

  /**
   * Gets a stream
   *
   * @returns {{ [reference: string]: Activity }}
   * @returns {Activity}
   * @memberof Stream
   */
  public getActivityStreams(): { [reference: string]: Activity };
  public getActivityStreams(stream: any): Activity;
  public getActivityStreams(stream?: any): any {
    if (stream) {
      // Return Existing Stream
      if (this.activities[stream]) return this.activities[stream];
      // Return New
      return this.newActivityStream(stream);
    }
    return this.activities;
  }

  /**
   * How many signatures in this transaction (m of n)
   *
   * @param {number} m
   * @returns {boolean}
   * @memberof Stream
   */
  public getMofSignatures(m: number): boolean {
    // Get total Signatures and compare
    return Object.keys(this.sigs).length >= m;
  }

  /**
   * Gets read only stream data defined by $r of the transactions
   *
   * @param {string} name
   * @returns {*}
   * @memberof Stream
   */
  public getReadOnlyStream(name: string): any {
    if (this.reads[name]) return this.reads[name];
    return false;
  }

  /**
   * Return the inbound INC messages
   *
   * @param {number} secret
   * @returns {Object[]}
   * @memberof Stream
   */
  protected getInterNodeComms(): ActiveDefinitions.ICommunications {
    return (global as any).INC as ActiveDefinitions.ICommunications;
  }

  /**
   * Set the data that is sent out by this node for INC
   *
   * @param {object} data
   * @memberof Stream
   */
  protected setThisInterNodeComms(data: object): void {
    this.outINC = data;
  }

  /**
   * Get this nodes outbound INC
   *
   * @param {number} secret
   * @returns {object}
   * @memberof Stream
   */
  public getThisInterNodeComms(secret: number): object {
    return this.outINC;
  }

  /**
   * Throw this transaction to another ledger
   *
   * @param {string} location
   * @memberof Stream
   */
  public throw(location: string): void {
    if (this.throwTo) {
      this.throwTo.push(location);
    } else {
      this.throwTo = [location];
    }
  }

  /**
   * Check to see if this is the node that the contract is running on
   *
   * @param {string} host host:port
   * @returns
   * @memberof Stream
   */
  public isExecutingOn(host: string) {
    return host == this.selfHost;
  }

  /**
   * Set the next timeout tick
   *
   * @protected
   * @param {number} ms
   * @memberof Stream
   */
  protected setTimeout(ms: number): void {
    // Get Current time
    let timeout = new Date();
    // Add extended timeout
    timeout.setMilliseconds(ms);
    // overwrite next timeout
    this.nextTimeout = timeout;
  }

  /**
   * Fetch the next requested timeout time tick
   *
   * @returns {Date}
   * @memberof Stream
   */
  public getTimeout(): Date {
    return this.nextTimeout;
  }
}
/**
 * Manage an Activity Stream
 *
 * @class Activity
 */
export class Activity {
  /**
   * Has the activity been updated at all
   *
   * @type {boolean}
   * @memberof Activity
   */
  public updated: boolean = false;

  /**
   * Key to prevent VM access to export routine
   *
   * @private
   * @type {number}
   * @memberof Activity
   */
  private key: number;

  /**
   * Post decryption, Safe mode tries to ensure total network
   * consensus. Disabling it is dangerous but can be used correctly.
   *
   * @private
   * @type {boolean}
   * @memberof Stream
   */
  private safeMode: boolean = false;

  /**
   * Creates an instance of Activity.
   *
   * @param {string} name
   * @param {ActiveDefinitions.IMeta} meta
   * @param {ActiveDefinitions.IState} state
   * @param {ActiveDefinitions.IVolatile} volatile
   * @memberof Activity
   */
  constructor(
    private umid: string | null,
    private name: string | null,
    private signature: boolean,
    private meta: ActiveDefinitions.IMeta = { _id: null, _rev: null },
    private state: ActiveDefinitions.IState = { _id: null, _rev: null },
    public volatile: ActiveDefinitions.IVolatile = { _id: null, _rev: null }
  ) {
    // Only if name is defined (Quick solution)
    if (umid && name) {
      // Create stream that is name safe
      let stream = ActiveCrypto.Hash.getHash(umid + name, "sha256");

      this.state._id = stream;
      this.meta._id = stream + ":stream";
      this.volatile._id = stream + ":volatile";

      // Flag for search filtering
      // $ notation should be treated like a reservation for Activelegder
      this.meta.$stream = true;

      // Add name and umid to the meta (For Dev Reference)
      this.meta.umid = umid;
      this.meta.name = name;
    }
  }

  /**
   * Expose enable safe mode
   *
   * @memberof Activity
   */
  public setSafeMode() {
    this.safeMode = true;
  }

  /**
   * Exports the 3 states for protocol use
   * TODO : Apply some kind of rule
   *
   * @param {number} secret
   * @returns {ActiveDefinitions.LedgerStream}
   * @memberof Activity
   */
  public export2Ledger(secret: number): ActiveDefinitions.LedgerStream {
    if (this.key == secret) {
      return {
        meta: this.meta,
        volatile: this.volatile,
        state: this.state as ActiveDefinitions.IFullState
      };
    }
    throw new Error("Secret Key Needed");
  }

  /**
   * Set secret access key
   *
   * @param {number} secret
   * @memberof Activity
   */
  public setKey(secret: number): void {
    this.key = secret;
  }

  /**
   * Set access control of this stream (Contract Managed)
   * TODO: Allow multiple values to a single name
   *
   * @param {string} name
   * @param {string} stream
   * @memberof Activity
   */
  public setACL(name: string, stream: string) {
    if (this.safeMode) {
      throw new Error("Cannot set ACL in Safe Mode");
    } else {
      if (!this.meta.acl) this.meta.acl = {};
      this.meta.acl[name] = stream;

      // Set Update Flag
      this.updated = true;
    }
  }

  /**
   * Confirms access type and assigned stream
   * TODO: Allow multiple values to a single name
   *
   * @param {string} name
   * @returns {boolean}
   * @memberof Activity
   */
  public hasACL(name: string): boolean {
    if (this.meta.acl && this.meta.acl[name] == name) return true;
    return false;
  }

  /**
   * Does this activity stream have a signature for this transaction
   *
   * @returns {boolean}
   * @memberof Activity
   */
  public hasSignature(): boolean {
    return this.signature;
  }

  /**
   * If stream is holding an identity it needs to know the signing authority
   * if unknown use getAuthority of another acitivty stream
   *
   * @param {string} pubkey
   * @param {string} [type="rsa"]
   * @memberof Activity
   */
  public setAuthority(pubkey: string, type: string = "rsa"): void {
    if (this.safeMode) {
      throw new Error("Cannot set authority in Safe Mode");
    } else {
      // Only Inputs & New Streams can be here
      if (this.signature || (this.umid && this.name)) {
        this.meta.public = pubkey;
        this.meta.type = type;
        this.meta.hash = ActiveCrypto.Hash.getHash(pubkey, "sha256");

        // Set Update Flag
        this.updated = true;
      } else {
        throw new Error("Cannot set new authority on output stream");
      }
    }
  }

  /**
   * Returns signing authority useful for setting authority to another stream
   *
   * @returns {(string | undefined)}
   * @memberof Activity
   */
  public getAuthority(type: boolean = false): string | undefined {
    if (type) {
      return this.meta.type;
    } else {
      return this.meta.public;
    }
  }

  /**
   * Allows you to restrict this activity stream write access to a specific smart contract
   * if you want to set it to the current contract set the script as this.transactions.$contract
   *
   * @param {(string|Array<string>)} script
   * @returns {boolean}
   * @memberof Activity
   */
  public setContractLock(script: string | Array<string>): boolean {
    if (this.safeMode) {
      throw new Error("Cannot create set contract lock in Safe Mode");
    } else {
      if (this.name && this.umid) {
        if (Array.isArray(script)) {
          this.meta.contractlock = script;
        } else {
          this.meta.contractlock = [script];
        }
        return true;
      } else {
        return false;
      }
    }
  }

  /**
   * Allows you to restrict this activity stream write access to a specific smart contract namespace.
   * if you want to set it to the current namespace set the namespace as this.transactions.$namespace
   *
   * @param {(string | Array<string>)} namespace
   * @returns {boolean}
   * @memberof Activity
   */
  public setNamespaceLock(namespace: string | Array<string>): boolean {
    if (this.safeMode) {
      throw new Error("Cannot create set namespace lock in Safe Mode");
    } else {
      if (this.name && this.umid) {
        if (Array.isArray(namespace)) {
          this.meta.namespaceLock = namespace;
        } else {
          this.meta.namespaceLock = [namespace];
        }
        return true;
      } else {
        return false;
      }
    }
  }

  /**
   * Alise of getName
   *
   * @returns {string}
   * @memberof Activity
   */
  public getId(): string {
    return this.getName();
  }

  /**
   * Return the name of this activity stream
   *
   * @returns {string}
   * @memberof Activity
   */
  public getName(): string {
    return this.state._id as string;
  }

  /**
   * Get the data state from the activity stream
   *
   * @returns {ActiveDefinitions.IState}
   * @memberof Activity
   */
  public getState(): ActiveDefinitions.IState {
    // Deep copy
    let state: ActiveDefinitions.IState = JSON.parse(
      JSON.stringify(this.state)
    );

    // Remove _id & _rev
    if ((state as ActiveDefinitions.IFullState)._id)
      delete (state as ActiveDefinitions.IFullState)._id;

    if ((state as ActiveDefinitions.IFullState)._rev)
      delete (state as ActiveDefinitions.IFullState)._rev;

    return state;
  }

  /**
   * Set the data state into the activity stream
   *
   * @param {ActiveDefinitions.IState} state
   * @memberof Activity
   */
  public setState(state: ActiveDefinitions.IState): void {
    if (this.safeMode) {
      throw new Error("Cannot create set state in Safe Mode");
    } else {
      // Cast to full state to manage
      let fState: ActiveDefinitions.IFullState = state as ActiveDefinitions.IFullState;

      // Remove _id & _rev
      delete fState._id;
      delete fState._rev;

      // Merge Objects
      this.state = Object.assign(
        this.state,
        fState
      ) as ActiveDefinitions.IFullState;

      // Set Update Flag
      this.updated = true;
    }
  }

  /**
   * Get the volatile state from the activity stream
   *
   * @returns {ActiveDefinitions.IVolatile}
   * @memberof Activity
   */
  public getVolatile(): ActiveDefinitions.IVolatile {
    // Deep copy
    let volatile: ActiveDefinitions.IVolatile = JSON.parse(
      JSON.stringify(this.volatile)
    );

    // Remove _id & _rev
    if ((volatile as ActiveDefinitions.IFullState)._id)
      delete (volatile as ActiveDefinitions.IFullState)._id;
    if ((volatile as ActiveDefinitions.IFullState)._rev)
      delete (volatile as ActiveDefinitions.IFullState)._rev;

    return volatile;
  }

  /**
   * Set the volatile state into the activity stream
   *
   * @param {ActiveDefinitions.IState} state
   * @memberof Activity
   */
  public setVolatile(volatile: ActiveDefinitions.IVolatile): void {
    // Cast to full state to manage
    let fVolatile: ActiveDefinitions.IFullState = volatile as ActiveDefinitions.IFullState;

    // Remove _id & _rev
    if (fVolatile._id) delete fVolatile._id;
    if (fVolatile._rev) delete fVolatile._rev;

    // Merge Objects
    this.volatile = Object.assign(
      this.volatile,
      fVolatile
    ) as ActiveDefinitions.IFullState;

    // Set Update Flag
    this.updated = true;
  }

  /**
   * Consensus Number Generator
   * Warning: Not to be considered a RNG becausew if you know current streams, contracts and inputs you can work out this value
   * This is used for when you want to get a reference style identifier without knowing a name.
   *
   * @param {string} buffer
   * @returns {number}
   * @memberof Activity
   */
  public getCng(buffer?: string): number {
    let input: string = this.state._rev + buffer + this.meta._rev;
    let i: number = input.length;
    let num: number = 0;
    while (i--) {
      num += input.charCodeAt(i);
    }
    return num;
  }
}

/**
 * Reexport ActiveCrypto Wrapper
 *
 * @export
 * @class ActiveCrypto
 */
export class ActiveCrypto {
  /**
   * Typed reference to external crypto object
   *
   * @private
   * @static
   * @memberof ActiveLogger
   */
  private static reference = ((global as unknown) as any).crypto;

  public static Hash: DefaultActiveCrypto.Hash = ActiveCrypto.reference.Hash;
  public static KeyPair: DefaultActiveCrypto.KeyPair =
    ActiveCrypto.reference.KeyPair;
  public static Secured: DefaultActiveCrypto.Secured =
    ActiveCrypto.reference.Secured;
}

/**
 * Rexport ActiveLogger via wrapper to change console log output colour
 *
 * @export
 * @class ActiveLogger
 */
export class ActiveLogger {
  /**
   * Typed reference to external logger object
   *
   * @private
   * @static
   * @memberof ActiveLogger
   */
  private static reference = ((global as unknown) as any)
    .logger as DefaultActiveLogger;

  public static trace(msg: string): void;
  public static trace(obj: object, msg?: string): void;
  public static trace(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.trace(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }

  public static debug(msg: string): void;
  public static debug(obj: object, msg?: string): void;
  public static debug(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.debug(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }

  public static info(msg: string): void;
  public static info(obj: object, msg?: string): void;
  public static info(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.info(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }

  public static warn(msg: string): void;
  public static warn(obj: object, msg?: string): void;
  public static warn(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.warn(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }

  public static error(msg: string): void;
  public static error(obj: object, msg?: string): void;
  public static error(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.error(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }

  public static fatal(msg: string): void;
  public static fatal(obj: object, msg?: string): void;
  public static fatal(p1: any, p2?: any): void {
    ActiveLogger.reference.setVMRuntime(true);
    ActiveLogger.reference.fatal(p1, p2);
    ActiveLogger.reference.setVMRuntime(false);
  }
}
