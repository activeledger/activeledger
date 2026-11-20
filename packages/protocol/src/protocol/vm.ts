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

import * as events from "events";
import { ActiveOptions, ActiveDSConnect, ActiveClone } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Activity, PostProcessEvent } from "@activeledger/activecontracts";
import { EventEngine } from "@activeledger/activequery";
import { ActiveLogger } from "@activeledger/activelogger";
import { ContractScope } from "@activeledger/activeutilities";
import { setTimeout } from "timers";
import * as fs from "fs";
import { EventEmitter } from "events";
import {
  IVMDataPayload,
  IVMContractReferences,
  IVirtualMachine,
  IContractIsolateBackend,
  IVMExecution,
  IVMExecutionReport,
} from "./interfaces/vm.interface";
import { runSandboxed, runUnsandboxed, bindToContext, normalise } from "./sandbox";
import { ReadLock } from "./readlock";
import { Attestation } from "./attest";
import { createInterface } from "readline";
import { serialize as v8Serialize, deserialize as v8Deserialize } from "v8";

/**
 * Each default contract is handed its own copy of the system configuration (it
 * may change what it was handed, and must not change another's). The copy is
 * made from a snapshot serialised once and rebuilt whenever ActiveOptions
 * reports a change (a reload, a ledger update of security or consensus), so
 * a contract is never handed stale security settings.
 */
let sysConfigSnapshot: Buffer | undefined;
let sysConfigSnapshotVersion = -1;
const sysConfigCopy = (): any => {
  if (!sysConfigSnapshot || sysConfigSnapshotVersion !== ActiveOptions.configVersion) {
    const version = ActiveOptions.configVersion;
    sysConfigSnapshot = v8Serialize(ActiveOptions.fetch(false));
    // Only once it worked: a throw above must not leave a stale snapshot marked current
    sysConfigSnapshotVersion = version;
  }
  return v8Deserialize(sysConfigSnapshot);
};
//import { ContractControl } from "./vmscript";

/**
 * Contract Virtual Machine Controller
 *
 * @export
 * @class VirtualMachine
 */
export class VirtualMachine
  extends events.EventEmitter
  implements IVirtualMachine {
  /** Transactions whose post processing asked for a configuration reload */
  private reloadRequests = new Set<string>();

  /**
   * Cache of initialised smart contracts
   *
   * @private
   * @type {IVMInternalCache}
   */
  /**
   * Optional pluggable backend that runs untrusted contracts outside this
   * process. Unset by default (in-process execution behind securityScan()).
   * When security.contractIsolation is "isolate", a backend MUST be
   * registered or initialise() refuses to load a non-privileged contract
   * (fail-closed) - a public node never silently degrades to in-process
   * execution of untrusted code. See IContractIsolateBackend.
   */
  private static isolateBackend: IContractIsolateBackend | null = null;

  /**
   * Register (or clear, with null) the process-wide contract isolation
   * backend. Intended to be called once at node start by an isolate add-on.
   */
  public static registerIsolateBackend(
    backend: IContractIsolateBackend | null
  ): void {
    VirtualMachine.isolateBackend = backend;
  }

  private smartContracts: { [umid: string]: any } = {};

  /**
   * Caches the constructable contract
   *
   * @private
   */
  private contracts: { [location: string]: any } = {};

  /**
   * Virtual Machine Object
   *
   * @private
   * @type {VM}
   */
  //private virtual: NodeVM;

  /**
   * Holds the VM instance
   *
   * @private
   * @type {*}
   */
  private virtualInstance: any; // IVMObject;

  /**
   * References to the contracts
   *
   * @private
   * @type {IVMContractReferences}
   */
  private contractReferences: IVMContractReferences;

  /**
   * Holds the event engine
   *
   * @private
   * @type {{ [umid: string]: EventEngine }}
   */
  private events: { [umid: string]: EventEngine } = {};

  /**
   * Holds the event emitter
   *
   * @private
   * @type {EventEmitter}
   */
  private emitter: EventEmitter;

  /**
   * When this VM timeout can not be extended past.
   *
   * @private
   * @type {Date}
   */
  private maxTimeout: Date;

  /**
   * Script execution status
   *
   * @private
   * @type {{ [umid: string]: boolean }}
   */
  private scriptFinishedExec: { [umid: string]: boolean } = {};

  /**
   * Timeout timers for each contract
   *
   * @private
   * @type {{ [umid: string]: NodeJS.Timeout }}
   */
  private timeoutTimers: { [umid: string]: NodeJS.Timeout } = {};

  /**
   * Per-execution options from a hybrid (or any dry run). Absent for an
   * ordinary supernode execution, which then runs exactly as before.
   *
   * @private
   */
  private executions: { [umid: string]: IVMExecution } = {};

  /**
   * Why each hybrid execution depends on the supernodes, as seen by the
   * host: blocked egress and volatile it does not hold. The contract keeps
   * its own reasons (isSupernode, inter-node comms).
   *
   * @private
   */
  private hostDependence: { [umid: string]: string[] } = {};

  /**
   * Events db for dry runs: nothing is written
   *
   * @private
   */
  private static readonly discardEvents = {
    post: (): Promise<any> => Promise.resolve({ ok: true }),
  };

  /**
   * The events database as the node uses it for the rows a contract raises.
   * A contract calls emit() from inside its own scope, where the storage
   * guard refuses the node's storage, so the write is made outside it. The
   * contract only supplies the event's name and data.
   *
   * @private
   */
  private readonly nodeEvents = {
    post: (doc: any): Promise<any> => ContractScope.outside(() => this.dbev.post(doc)),
  };

  /**
   * Creates an instance of VirtualMachine.
   * @param {string} contractPath
   * @param {string} selfHost
   * @param {string} umid
   * @param {Date} cdate
   * @param {ActiveDefinitions.LedgerTransaction} tx
   * @param {ActiveDefinitions.LedgerSignatures} sigs
   * @param {ActiveDefinitions.LedgerStream[]} inputs
   * @param {ActiveDefinitions.LedgerStream[]} outputs
   * @param {ActiveDefinitions.LedgerIORputs} reads
   * @param {ActiveDSConnect} db
   * @param {ActiveDSConnect} dbev
   */
  constructor(
    private selfHost: string,
    private db: ActiveDSConnect,
    private dbev: ActiveDSConnect
  ) {
    super();
    // Initialise the emitter for listening and pass through to the contract
    this.emitter = new EventEmitter();
    // Start volatile event listener
    this.listenForVolatile();
    // start all stream fetching
    this.listenForFetch();
    // Directly assign the script controller instance
  }

  /**
   * Initialise the Virtual machine instance
   *
   * @private
   */
  public initialiseVirtualMachine(): void {
    // This method is now a stub since vm2 is removed.
    // The virtualInstance is assigned in the constructor.
    // This can be removed in a future refactor.
  }

  /**
   * Safe accessor for smart contracts
   *
   * @private
   * @param {string} umid
   * @returns {*}
   */
  private getContract(umid: string, by?:string): any {
    if (!this.smartContracts[umid]) {
        ActiveLogger.warn(`[AC] Contract ${umid} accessed but not found (already destroyed?) by ${by || 'unknown'}`);
        return null;
    }
    return this.smartContracts[umid];
  }

  /**
   * Run contract code. A hybrid execution runs inside the egress sandbox;
   * anything else is called directly, as it always was.
   *
   * @private
   */
  private sandboxed<T>(umid: string, fn: () => T): T {
    const execution = this.executions[umid];
    if (!execution || execution.supernode) {
      const tx = this.contractReferences?.[umid]?.tx;
      // The node's own (default namespace) contracts are trusted, as the
      // security scan treats them
      if (tx?.$namespace === "default") return fn();
      const policy = ActiveOptions.get<any>("security", {})?.contractEgress || {};
      // From build 50600, like the namespace binding it goes with, so a network
      // that has not raised its build behaves as before.
      // security.contractEgress.storage: "allow" switches the guard off; "deny" closes the port
      // to everything the allow list does not name (by default custom databases are open).
      if (!ReadLock.enabled() || policy.storage === "allow") return fn();
      this.protectStorage();
      // What this contract's namespace (or namespace/contract) may reach in spite of the guard
      const lists = policy.allow || {};
      const contract = String(tx?.$contract ?? "").split("@")[0];
      const entries: string[] = [
        ...(Array.isArray(lists[tx?.$namespace]) ? lists[tx.$namespace] : []),
        ...(contract && Array.isArray(lists[`${tx?.$namespace}/${contract}`]) ? lists[`${tx?.$namespace}/${contract}`] : []),
      ].filter((e) => typeof e === "string");
      // This machine's other ports are closed to a contract unless its namespace has
      // allowLocalhost in security.namespace.<namespace>.policy
      const nsPolicy = ActiveOptions.get<any>("security", {})?.namespace?.[String(tx?.$namespace ?? "").toLowerCase()]?.policy;
      return runSandboxed(
        {
          mode: "storage",
          denyLocalhost: nsPolicy?.allowLocalhost !== true,
          // Custom databases are shut like the rest of the port unless the node opts in with storage: "open" or this namespace has allowDatabases in its policy
          customDatabases: policy.storage === "open" || nsPolicy?.allowDatabases === true || (Array.isArray(nsPolicy?.allowDatabases) && nsPolicy.allowDatabases.includes("*")),
          // allowDatabases can instead be a list of database names
          databases: Array.isArray(nsPolicy?.allowDatabases) ? nsPolicy.allowDatabases.filter((d: unknown) => typeof d === "string") : undefined,
          // What one contract call may use: how long a request may take and how much it may read.
          // security.contractEgress.timeoutSeconds (5) and .maxResponseBytes (2 MB)
          limits: {
            // A namespace can have its own (security.namespace.<ns>.policy.requestTimeoutSeconds / .maxResponseBytes)
            timeoutSeconds: Number(nsPolicy?.requestTimeoutSeconds) > 0 ? Number(nsPolicy.requestTimeoutSeconds) : Number(policy.timeoutSeconds) > 0 ? Number(policy.timeoutSeconds) : 5,
            maxResponseBytes: Number(nsPolicy?.maxResponseBytes) > 0 ? Number(nsPolicy.maxResponseBytes) : Number(policy.maxResponseBytes) > 0 ? Number(policy.maxResponseBytes) : 2 * 1024 * 1024,
          },
          spent: { bytes: 0 },
          inflight: new Set<() => void>(),
          ended: { value: false },
          allow: entries.length ? (destination) => ContractScope.listed(entries, destination) : undefined,
          onBlocked: (what) =>
            ActiveLogger.warn(`Contract refused access to ${what} (${umid})`),
        },
        fn
      );
    }
    return runSandboxed(
      { onBlocked: (what) => this.markHostDependent(umid, `blocked:${what}`) },
      fn
    );
  }

  /**
   * Tell the shared guard which ports are this node's storage. Read from the
   * config each time (it is a few property reads) and passed on only when it
   * has changed.
   *
   * @private
   */
  private protectedStorage = "";
  private protectStorage(): void {
    const db = ActiveOptions.get<any>("db", {}) || {};
    const ports: Array<number | string | undefined> = [db.selfhost?.port];
    try {
      if (db.url) ports.push(new URL(db.url).port || undefined);
    } catch {
      // not a URL
    }
    // Further ports to keep contracts off (security.contractEgress.protect)
    const extra = ActiveOptions.get<any>("security", {})?.contractEgress?.protect;
    if (Array.isArray(extra)) ports.push(...extra);
    const names = [
      db.database, db.event, db.error, db.error && `${db.error}_archive`,
      "activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror",
      "activeledgererrors_archive", "activeledgererror_archive",
    ];
    // The ports and the node's own database names, so a change to either is picked up
    const key = ports.join(",") + "|" + names.join(",");
    if (key === this.protectedStorage) return;
    this.protectedStorage = key;
    ContractScope.protectPorts(ports);
    // The node's own databases are out of bounds to every contract, listed or not
    ContractScope.neverDatabases(names);
  }

  /**
   * Record a reason a hybrid execution depends on the supernodes
   *
   * @private
   */
  private markHostDependent(umid: string, reason: string): void {
    const reasons = (this.hostDependence[umid] ||= []);
    if (reasons.indexOf(reason) === -1) reasons.push(reason);
  }

  /**
   * What a hybrid needs to judge this execution: whether (and why) it
   * depends on the supernodes, and the adopt declarations it recorded.
   *
   * @param {string} umid
   * @returns {IVMExecutionReport}
   */
  public getExecutionReport(umid: string): IVMExecutionReport {
    const contract = this.smartContracts[umid];
    const reasons = (this.hostDependence[umid] || []).slice();
    if (contract && typeof contract.getSupernodeDependence === "function") {
      for (const reason of contract.getSupernodeDependence() as string[]) {
        if (reasons.indexOf(reason) === -1) reasons.push(reason);
      }
    }
    return {
      supernodeDependent: reasons.length > 0,
      dependence: reasons,
      adopt:
        contract && typeof contract.exportAdoptDeclarations === "function"
          ? contract.exportAdoptDeclarations()
          : [],
    };
  }

  /**
   * Extract All changed streams
   *
   * @returns {{ [reference: string]: Activity }}
   */
  public getActivityStreamsFromVM(
    umid: string
  ): ActiveDefinitions.LedgerStream[] {
    const contract = this.getContract(umid, "getActivityStreamsFromVM");
    if (!contract) return [];

    // Fetch Activities and prepare to check
    let activities: {
      [reference: string]: Activity;
    } = contract.getActivityStreams();
    let streams: string[] = Object.keys(activities);
    let i = streams.length;

    let contractData: ActiveDefinitions.IContractData | undefined;
    if (contract.updatedContractData) {
      contractData = contract.exportContractData();
    }

    // The exported streams with changes
    let exported: ActiveDefinitions.LedgerStream[] = [];

    if (contractData) {
      exported.push(contractData as unknown as ActiveDefinitions.LedgerStream);
    }

    // If we are performing a staged rollout, hide the new auditing features
    // until the 'build' flag is configured to 40000 or higher. This allows
    // legacy nodes to process transactions without data schema conflicts.
    // Invariant across every stream in this call, so read it once rather
    // than on every updatedMeta stream in the loop below.
    const build = ActiveOptions.get<number>("build", 0);

    // Loop each stream and find the marked ones
    while (i--) {
      if (activities[streams[i]].updated) {
        // Activities have it referenced now
        const stream: any = {
          //@ts-ignore
          state: activities[streams[i]].state
        }

        if (activities[streams[i]].updatedMeta) {
          //@ts-ignore
          stream.meta = activities[streams[i]].meta;

          // Separate threshold to the 40000 strip below: expiry changes
          // how a node VOTES, not just what it stores, so a node below it
          // must neither persist nor act on the field.
          if (build < 40100 && Array.isArray(stream.meta?.authorities)) {
            for (const auth of stream.meta.authorities) {
              if (auth && "expire" in auth) {
                delete (auth as any).expire;
              }
            }
          }

          if (build < 40000) {
            if (stream.meta) {
              if (stream.meta.removedAuthorities) {
                delete stream.meta.removedAuthorities;
              }
              if (Array.isArray(stream.meta.authorities)) {
                for (const auth of stream.meta.authorities) {
                  if (auth && "umid" in auth) {
                    delete (auth as any).umid;
                  }
                }
              }
            }
          }
        }

        if (activities[streams[i]].volatileUpdated) {
          //@ts-ignore
          stream.volatile = activities[streams[i]].volatile;
        }

        exported.push(stream)
      }
    }

    return exported;
  }

  /**
   * Fetch if contract data got updated
   *
   * @param {string} umid
   * @return {*}  {boolean}
   */
  public getNewContractData(
    umid: string
  ): boolean {
    const contract = this.getContract(umid, "getNewContractData");
    if (contract && contract.updatedContractData) {
      return contract.exportContractData();
    }
    return false;
  }

  /**
   * Clear transaction from memory by umid
   *
   * @param {string} umid
   */
  public destroy(umid: string): void {
    try {
      // Clear timeout timer if exists
      if (this.timeoutTimers[umid]) {
        clearTimeout(this.timeoutTimers[umid]);
        delete this.timeoutTimers[umid];
      }

      if (this.smartContracts[umid] && "shutdown" in this.smartContracts[umid]) {
        ActiveLogger.info(`[AC] - Calling Shutdown - ${umid}`);
        this.smartContracts[umid].shutdown!();
      }
      const execution = this.executions[umid];
      const instance = this.smartContracts[umid];
      setTimeout(() => {
        if (execution) {
          // A hybrid may run the same umid again (dry-run vote, then the
          // committed item); leave a newer execution's state alone
          if (this.smartContracts[umid] !== instance) return;
          delete this.executions[umid];
          delete this.hostDependence[umid];
        }
        delete this.smartContracts[umid];
        delete this.events[umid];
        delete this.scriptFinishedExec[umid];
      }, 5000);
    } catch {
      // Already deleted?
    }

    // Clear references here
    if (this.contractReferences && this.contractReferences[umid]) {
      delete this.contractReferences[umid];
    }
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   */
  public getInternodeCommsFromVM(umid: string): any {
    const contract = this.getContract(umid, "getInternodeCommsFromVM"); return contract ? contract.getThisInterNodeComms() : null;
  }

  /**
   * Are we suppose to clear the node comms
   *
   * @returns {boolean}
   */
  public clearingInternodeCommsFromVM(umid: string): boolean {
    const contract = this.getContract(umid, "clearingInternodeCommsFromVM"); return contract ? contract.getClearInterNodeComms() : false;
  }

  /**
   * Data to send back to the requesting http client
   *
   * @returns {boolean}
   */
  public getReturnContractData(umid: string): unknown {
    const contract = this.getContract(umid, "getReturnContractData");
    return contract ? contract.getReturnToRemote() : null;
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   */
  public getThrowsFromVM(umid: string): string[] {
    const contract = this.getContract(umid, "getThrowsFromVM");
    return contract ? contract.throwTo : [];
  }

  /**
   * Every event this transaction's contract raised, in emission order -
   * for streamUpdater.ts to attach to the transaction's umid document so
   * a node restoring this transaction later can replay them.
   *
   * @returns {any[]}
   */
  public getEvents(umid: string): any[] {
    return this.events[umid] ? this.events[umid].getEvents() : [];
  }

  /**
   * Get current working inputs of the contract (External to VM)
   *
   * @returns {ActiveDefinitions.LedgerStream[]}
   */
  public getInputs(umid: string): ActiveDefinitions.LedgerStream[] {
    return this.contractReferences[umid].inputs;
  }

  /**
   * The lock fields of the streams this execution was loaded with, as they
   * were before the contract ran (a private copy, see ReadLock.snapshot)
   *
   * @param {string} umid
   */
  public getLoadedLocks(
    umid: string
  ): ((stream: string) => ActiveDefinitions.IMeta | undefined) | undefined {
    return this.contractReferences?.[umid]?.lockOf;
  }

  /**
   * The consensus time for event ids, from build 40300. The events travel in
   * the `:umid` document, which supernodes must write identically so a hybrid
   * can check it against a signed hash; a local clock in the ids made every
   * node's copy different. Below the build ids stay locally stamped, so a
   * half-upgraded network does not disagree about them.
   */
  private eventStamp(payload: IVMDataPayload): number | undefined {
    if (ActiveOptions.get<number>("build", 0) < 40300) return undefined;
    const ms = new Date((payload as any).date).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }

  /**
   * Dynamically import the contract.
   *
   * @returns {Promise<void>}
   */
  public initialise(
    payload: IVMDataPayload,
    contractName: string,
    execution?: IVMExecution
  ): Promise<void> {
    if (!this.contractReferences) {
      this.contractReferences = {};
    }

    this.contractReferences[payload.umid] = {
      contractName,
      contractLocation: payload.contractLocation,
      inputs: payload.inputs,
      // Copied now, before the contract can touch the streams it is handed
      lockOf: ReadLock.snapshot(payload.inputs, payload.outputs),
      tx: payload.transaction,
      key: payload.key,
    };

    if (execution) {
      this.executions[payload.umid] = execution;
      this.hostDependence[payload.umid] = [];
    } else {
      delete this.executions[payload.umid];
    }

    // Setup Event Engine (a dry run keeps its events in memory only)
    this.events[payload.umid] = new EventEngine(
      execution?.dryRun ? VirtualMachine.discardEvents : this.nodeEvents,
      payload.transaction.$contract,
      payload.umid,
      this.eventStamp(payload),
      (id, error) =>
        ActiveLogger.error({ umid: payload.umid, id, error }, "Event row not written")
    );

    return Promise.resolve()
      .then(async () => {
        // Initialise Contract into VM
        const contractData = payload.contractData?.data ? payload.contractData : {};

        // Contract-isolation policy. "inprocess" (default) preserves the
        // historical behaviour: source is admitted by securityScan() and the
        // contract is require()d and constructed in this process. "isolate"
        // is for a node open to untrusted deployers - every non-privileged
        // contract must run behind a registered isolate backend, and if none
        // is registered we refuse rather than run untrusted code in-process.
        const security = ActiveOptions.get<any>("security", {}) || {};
        const isolation: string = security.contractIsolation || "inprocess";
        // System ("default") namespace contracts are the node's own and are
        // always trusted - mirrors securityScan()'s privileged-namespace skip.
        const isPrivileged = payload.transaction.$namespace === "default";

        const constructorArgs = [
          payload.date,
          payload.remoteAddress,
          payload.umid,
          payload.transaction,
          payload.inputs,
          payload.outputs,
          payload.readonly,
          contractData,
          payload.signatures,
          payload.key,
          this.contractEmitter(),
          this.selfHost,
        ];

        if (isolation === "isolate" && !isPrivileged) {
          const backend = VirtualMachine.isolateBackend;
          if (!backend) {
            // Fail-closed: never fall back to in-process for a public node.
            throw new Error(
              "security.contractIsolation is 'isolate' but no isolate backend is registered - refusing to run contract '" +
                contractName +
                "' in-process. Register an isolate backend (VirtualMachine.registerIsolateBackend) or set contractIsolation to 'inprocess' for permissioned deployment."
            );
          }
          if (!this.contracts[payload.contractLocation]) {
            this.contracts[payload.contractLocation] = await backend.load(
              payload.contractLocation
            );
          }
          this.smartContracts[payload.umid] = await this.sandboxed(
            payload.umid,
            () =>
              this.contracts[payload.contractLocation].instantiate(
                constructorArgs
              )
          );
        } else {
          this.sandboxed(payload.umid, () => {
            // Fetch Contract Constructable
            if (!this.contracts[payload.contractLocation]) {
              this.contracts[payload.contractLocation] = require(payload.contractLocation).default;
            }

            this.smartContracts[payload.umid] = new this.contracts[
              payload.contractLocation
            ](...constructorArgs);
          });
        }

        // Tell the contract where it runs (isSupernode)
        if (
          execution &&
          typeof this.smartContracts[payload.umid].setHostMode === "function"
        ) {
          this.smartContracts[payload.umid].setHostMode(execution.supernode);
        }

        // Reserve activeledger.default.* stream names for the default
        // namespace. Gated because it changes which transactions pass.
        if (
          typeof this.smartContracts[payload.umid].setReservedStreams ===
          "function"
        ) {
          this.smartContracts[payload.umid].setReservedStreams(
            ActiveOptions.get<number>("build", 0) >= Attestation.BUILD
          );
        }

        if ("setEvent" in this.smartContracts[payload.umid]) {
          (this.smartContracts[payload.umid] as PostProcessEvent).setEvent(
            this.events[payload.umid]
          );
        }

        // Set Sys Config for default namespace contracts
        if (payload.transaction.$namespace === "default") {
          if ("sysConfig" in this.smartContracts[payload.umid]) {
            (this.smartContracts[payload.umid] as unknown as any).sysConfig(
              sysConfigCopy()
            );
          }
        }

        // From here the host only reaches the contract through a facade that runs every call
        // inside the contract's sandbox (see scopedContract)
        this.smartContracts[payload.umid] = this.scopedContract(
          payload.umid,
          this.smartContracts[payload.umid]
        );

        // Set the maximum timeout for this contract execution
        this.maxTimeout = new Date();
        this.maxTimeout.setMilliseconds(
          ActiveOptions.get<number>("contractMaxTimeout", 20) * 60 * 1000
        );
      })
      .catch(async (e) => {
        // Rethrow a formatted exception
        throw await this.catchException(e, payload.umid);
      });
  }

  /**
   * Set phase in event engine
   *
   * Checks to make sure event object exists due to an occurance
   * where it can be undefined. Source of the problem to be found only happens
   * with the spam tool, This is allows for spam to continue.
   *
   * @private
   * @param {string} phase
   */
  private setPhase(phase: string, umid: string) {
    if (this.events[umid]) {
      this.events[umid].setPhase(phase);
    }
  }

  /**
   * Run an unknown contract read function
   *
   * @returns {Promise<boolean>}
   */
  public async read(umid: string, readMethod: string): Promise<unknown> {
    return new Promise(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec[umid] = false;

      // Upgrade Phase
      this.setPhase("read", umid);

      // Manage Timeout
      this.checkTimeout(
        readMethod,
        () => {
          reject("VM Error : Read phase timeout");
        },
        umid
      );

      try {
        // Get Commit
        const contract = this.getContract(umid, "read"); if (!contract) return reject("VM Error : Contract not found"); const read = await this.sandboxed(umid, () => (contract as any)[readMethod]?.());
        resolve(read ? read : false);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Read - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Run verify part of the smart contract
   *
   * @returns {boolean}
   */
  public verify(sigless: boolean, umid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec[umid] = false;

      // Upgrade Phase
      this.setPhase("verify", umid);

      // Manage Timeout
      this.checkTimeout(
        "verify",
        () => {
          reject("VM Error : Verify phase timeout");
        },
        umid
      );

      try {
        // Run Verify Phase
        const contract = this.getContract(umid, "verify"); if (!contract) return reject("VM Error : Contract not found"); const verify = await this.sandboxed(umid, () => contract.verify?.(sigless));
        resolve(verify ? verify : true);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Verify - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Run vote part of the smart contract
   *
   * @returns {boolean}
   */
  public vote(nodes: ActiveDefinitions.INodes, umid: string): Promise<boolean | { leader: boolean }> {
    return new Promise<boolean | { leader: boolean }>(async (resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec[umid] = false;

      // Upgrade Phase
      this.setPhase("vote", umid);

      // Manage Timeout
      this.checkTimeout(
        "vote",
        () => {
          reject("VM Error : Vote phase timeout");
        },
        umid
      );

      try {
        // Run Vote Phase
        const contract = this.getContract(umid, "vote"); if (!contract) return reject("VM Error : Contract not found"); resolve(await this.sandboxed(umid, () => contract.vote()));
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Vote - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Run commit part of the smart contract
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   */
  public commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean = false,
    umid: string
  ): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec[umid] = false;

      // Upgrade Phase
      this.setPhase("commit", umid);

      // Manage Timeout
      this.checkTimeout(
        "commit",
        () => {
          reject("VM Error : Commit phase timeout");
        },
        umid
      );

      try {
        // Get Commit
        const contract = this.getContract(umid, "commit"); if (!contract) return reject("VM Error : Contract not found"); await this.sandboxed(umid, () => contract.commit(possibleTerritoriality));
        // Here we may update the database from the objects (commit should return)
        // Or just manipulate / check the outputs
        resolve(true);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Commit - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Contract given the opportunity to reconcile itself when node voted no but network confimed
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @returns {Promise<any>}
   */
  public reconcile(
    nodes: ActiveDefinitions.INodes,
    umid: string
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        // Manage INC
        this.incMarshel(nodes, umid);

        // Script running flag
        this.scriptFinishedExec[umid] = false;

        // Upgrade Phase
        this.setPhase("reconcile", umid);
        // Manage Timeout
        this.checkTimeout(
          "reconcile",
          () => {
            reject("VM Error : Reconcile phase timeout");
          },
          umid
        );

        // Get Commit
        let result: any = Promise.resolve();
        const contract = this.getContract(umid, "reconcile"); if (contract && contract.reconcile) {
          result = this.sandboxed(umid, () => contract.reconcile!());
        }
        
        // Here we may update the database from the objects (commit should return)
        // Or just manipulate / check the outputs
        resolve(await result);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Reconcile - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Do something after the commit phase, Territoriality is if this is the first post commit
   * running in the entire network
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   */
  /**
   * Did this transaction's default contract ask for the configuration to be
   * reloaded (nodes added or removed, namespaces, hybrid rules)? Asked once,
   * by whoever owns the transaction, after post processing.
   */
  public takeReloadRequest(umid: string): boolean {
    return this.reloadRequests.delete(umid);
  }

  public postProcess(
    territoriality: boolean,
    who: string,
    umid: string
  ): Promise<any> {
    // Post-commit side effects belong to the node that really committed
    if (this.executions[umid]?.dryRun) return Promise.resolve(undefined);

    return new Promise(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec[umid] = false;

      // Upgrade Phase
      this.setPhase("post", umid);

      // Manage Timeout
      this.checkTimeout(
        "post",
        () => {
          reject("VM Error : Post phase timeout");
        },
        umid
      );

      try {
        // Run Post Process
        let result: any = Promise.resolve();
        const contract = this.getContract(umid, "postProcess"); if (contract && "postProcess" in contract) {
          result = this.sandboxed(umid, () =>
            (contract as PostProcessEvent).postProcess(territoriality, who)
          );
        }
        
        // Reload Configuration Required?
        if (this.contractReferences?.[umid]?.tx?.$namespace == "default") {
          if (contract && "sysConfig" in contract) {
            if ((contract as any).configReload()) {
              ActiveLogger.info("Reloading Configuration Request");
              this.reloadRequests.add(umid);
            }
          }
        }
        resolve(await result);
      } catch (error) {
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec[umid] = true;
      }
    });
  }

  /**
   * Marshel the INcomms into the contract
   *
   * @private
   * @param {ActiveDefinitions.INodes} nodes
   */
  private incMarshel(nodes: ActiveDefinitions.INodes, umid: string): void {
    // Get Node Keys (Or get from Neighbourhood?)
    let keys = Object.keys(nodes);

    if (keys) {
      let i = keys.length;
      if (i) {
        let comms: ActiveDefinitions.ICommunications = {};
        // Quick Flag to check if its worth sending large into VM
        let sendComms = false;

        // Find any comms
        while (i--) {
          if (nodes[keys[i]].incomms) {
            comms[keys[i]] = nodes[keys[i]].incomms;
            if (!sendComms) sendComms = true;
          }
        }

        // Any Comms to send into VM (Alternative parse directly as JSON)
        if (sendComms) {
          const contract = this.getContract(umid, "incMarshel"); if (contract) return contract.setInterNodeComms(
            this.contractReferences[umid].key,
            comms
          );
        }
      }
    }
  }

  // ? Not sure if this is needed??
  // public getVolatile() {}

  /**
   * A contract reads a document: refused when the stream's read lock does
   * not allow the namespace of the transaction that is running. The
   * namespace comes from the engine's own record of the execution, never
   * from anything the contract passes.
   *
   * @private
   */
  private contractRead(db: any, umid: string, id: string): Promise<any> {
    const reference = this.contractReferences?.[umid];
    return ReadLock.read(db, id, reference?.tx?.$namespace, reference?.lockOf);
  }

  /**
   * The event emitter a contract is given. The real one carries the host's own listeners, and
   * the answers to getVolatile / getStreamData are emitted from host work outside the
   * sandbox, so a listener the contract adds would run there. Each listener is bound to the
   * contract context it was added in, and the contract gets only these few methods.
   *
   * @private
   */
  private contractEmitter(): EventEmitter {
    const emitter = this.emitter;
    const bound = new WeakMap<Function, Function[]>();
    const add = (method: "on" | "once") => (event: string, listener: (...args: any[]) => void) => {
      const wrapped = bindToContext(listener);
      const list = bound.get(listener) || [];
      list.push(wrapped);
      bound.set(listener, list);
      emitter[method](event, wrapped);
      return facade;
    };
    const remove = (event: string, listener: (...args: any[]) => void) => {
      // One registration, the latest, as an EventEmitter does
      const wrapped = (bound.get(listener) || []).pop();
      if (wrapped) emitter.removeListener(event, wrapped as any);
      return facade;
    };
    const facade: any = Object.freeze({
      on: add("on"),
      addListener: add("on"),
      once: add("once"),
      off: remove,
      removeListener: remove,
      emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    });
    return facade;
  }

  /**
   * The contract as the rest of the VM sees it. Every property read and method call goes
   * through the sandbox, not only the main ones (vote, commit...) that already did: the VM
   * also calls getTimeout, shutdown, the export methods and others, and a contract can
   * replace any of them with code that would otherwise run outside its sandbox. Objects it
   * returns are copied to plain data inside the sandbox, so a toJSON or getter is not the
   * host's to run later.
   *
   * @private
   */
  private scopedContract(umid: string, instance: any): any {
    if (!instance || typeof instance !== "object") return instance;
    const plain = (value: any): any => {
      // Inside any contract sandbox, the storage guard's or a hybrid's network block: what the
      // host serialises later is plain data. Outside one (the default namespace) it is as returned
      if (!ContractScope.current()) return value;
      if (value && typeof value === "object") {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          // Not plain data (a cycle, a BigInt): left as it was, as it is without the guard
          return value;
        }
      }
      return value;
    };
    const wrappers = new Map<PropertyKey, Function>();
    const proxy: any = new Proxy(instance, {
      get: (target, prop) => {
        const value = this.sandboxed(umid, () => Reflect.get(target, prop, target));
        if (typeof value !== "function") return value;
        let wrapper = wrappers.get(prop);
        if (!wrapper || (wrapper as any).__target !== value) {
          wrapper = (...args: unknown[]) =>
            this.sandboxed(umid, () => {
              const result = value.apply(target, args);
              // A method that returns the contract itself returns the facade
              if (result === target) return proxy;
              // then is read once (normalise), and a thenable is awaited inside the sandbox
              const settled = normalise(result);
              return settled !== result ? settled.then(plain) : plain(result);
            });
          (wrapper as any).__target = value;
          wrappers.set(prop, wrapper);
        }
        return wrapper;
      },
    });
    return proxy;
  }

  private listenForVolatile(): void {
    this.emitter.on("getVolatile", (umidIn: string, streamIdIn: string) => {
      // These came from the contract. Made plain strings here, while still inside
      // its sandbox, so that what the host work below touches is data and not an
      // object whose toString or indexOf is the contract's own code, which would
      // run outside the sandbox.
      const umid = String(umidIn), streamId = String(streamIdIn);
      // Host work: never inside the contract's egress sandbox
      return runUnsandboxed(async () => {
        // Volatile is per node. A hybrid reads its own copy, as every node
        // does; what a contract does with a value that may differ is up to
        // the contract.
        const execution = this.executions[umid];
        try {
          const db = execution?.db || this.db;
          const volatile: ActiveDefinitions.IVolatile = await this.contractRead(
            db,
            umid,
            `${streamId}:volatile`
          );
          // The store answers a missing document with its error body, not an
          // error. That is not volatile data (a contract that wrote it back
          // would store the error), it is a volatile that is not there.
          if (!volatile || (volatile as any).notFound === true) {
            throw new Error("Volatile Data - Not Found");
          }
          this.emitter.emit(`volatileFetched-${umid}${streamId}`, null, volatile);
        } catch (error) {
          this.emitter.emit(`volatileFetched-${umid}${streamId}`, error);
        }
      });
    });
  }

  /**
   * Allow for any stream data to be fetched during contract execution
   *
   * @private
   */
  private listenForFetch(): void {
    this.emitter.on("getStreamData", (umidIn: string, streamIdIn: string) => {
      // As getVolatile: plain strings, made inside the contract's sandbox
      const umid = String(umidIn), streamId = String(streamIdIn);
      // Host work: never inside the contract's egress sandbox
      return runUnsandboxed(async () => {
        try {
          const db = this.executions[umid]?.db || this.db;
          const data: ActiveDefinitions.IStream = await this.contractRead(
            db,
            umid,
            streamId
          );
          this.emitter.emit(
            `getStreamDataFetched-${umid}${streamId}`,
            null,
            data
          );
        } catch (error) {
          this.emitter.emit(`getStreamDataFetched-${umid}${streamId}`, error);
        }
      });
    });
  }

  /**
   * Check the VM has or hasn't timedout
   *
   * @private
   * @param {string} type
   * @param {Function} timedout
   */
  private checkTimeout(type: string, timedout: Function, umid: string): void {
    // Clear any existing timer for this UMID phase
    if (this.timeoutTimers[umid]) {
      clearTimeout(this.timeoutTimers[umid]);
    }

    // This function recursively checks if a contract phase has timed out.
    this.timeoutTimers[umid] = setTimeout(() => {
      // If the script is still running...
      if (!this.scriptFinishedExec[umid]) {
        // ...check if the contract has requested a timeout extension.
        if (this.hasBeenExtended(umid)) {
          // If extended, check again later.
          this.checkTimeout(type, timedout, umid);
        } else {
          // If not extended, trigger the timeout function.
          timedout();
          delete this.timeoutTimers[umid];
        }
      } else {
        // Clean up timer tracking
        delete this.timeoutTimers[umid];
      }
    }, ActiveOptions.get<number>("contractCheckTimeout", 10000));
  }

  /**
   * Detect if the script is within timeout limits
   *
   * @private
   * @returns {boolean}
   */
  private hasBeenExtended(umid: string): boolean {
    // Check if contract exists before accessing
    const contract = this.getContract(umid, "hasBeenExtended");
    if (!contract) return false;
    
    // Fetch new time out request from the contract
    let timeoutRequestTime = contract.getTimeout();

    // Did we get a return value to work on?
    if (timeoutRequestTime) {
      // if request time larger than current time extention has been requested
      // also check the request timeout is not larger than the maximum allowed
      if (
        this.maxTimeout > timeoutRequestTime &&
        timeoutRequestTime > new Date()
      ) {
        // Timeout has been extended correctly.
        return true;
      }
    }

    // Script has timed out
    return false;
  }

  /**
   * Manages Exceptions / Throws from a VM call
   *
   * @private
   * @param {Error} e
   * @returns {*}
   */
  private async catchException(e: Error, umid: string): Promise<any> {
    // Exception
    if (
      e.stack &&
      umid &&
      this.contractReferences &&
      this.contractReferences[umid]?.contractName
    ) {
      // Get Current Contract Filename only
      const contract = this.contractReferences[umid].contractName;

      // Find Contract Code in Stacktrace
      const contractErrorLine = e.stack.match(
        new RegExp(`^.*${contract}.*$`, "m")
      );

      // Was our contract in the stack trace
      if (contractErrorLine && contractErrorLine.length) {
        // Get First Match
        const contractLastCallLine = contractErrorLine[0].trim();

        // Find Contract Start
        const lastIndexFolder = contractLastCallLine.indexOf(contract);

        // Extract Contract + Line Numbers
        let contractErrorInfo = contractLastCallLine.substring(
          lastIndexFolder,
          contractLastCallLine.length
        );

        // This should already be filtered at the output but double check as it
        // will also prevent reading files
        let line;
        if (ActiveOptions.get<boolean>("debug", false)) {
          line = (
            await this.readNthLine(
              this.contractReferences[umid].contractLocation,
              parseInt(
                contractErrorInfo.substring(
                  contractErrorInfo.indexOf(":") + 1,
                  contractErrorInfo.lastIndexOf(":")
                )
              )
            )
          ).trim();
        }

        return {
          error: e.message,
          at: contractErrorInfo,
          line,
        };
      } else {
        // Degrade to first line from the trace
        // Get file with line numbers
        let msg = e.stack
          .split("\n", 2)[1]
          .trim()
          .replace(/.*\(|\)/gi, "");

        // Extract Line numbers
        // Add Contract Name
        msg = contract + ":" + msg.substr(msg.indexOf(".js") + 4);

        //return reject(e.message + "@" + msg);
        return {
          error: e.message,
          at: msg,
        };
      }
    } else {
      return e.message;
    }
  }

  /**
   * Stream reads specific line from file (Debugging only)
   *
   * @private
   * @param {string} file
   * @param {number} nthLine
   * @returns {Promise<string>}
   */
  private async readNthLine(file: string, nthLine: number): Promise<string> {
    const rl = createInterface({
      input: fs.createReadStream(file),
    });

    // Loop lines searching for nth
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (lineNumber === nthLine) {
        // Found close and return
        rl.close();
        return line;
      }
    }
    // Didn't find still close and return empty
    rl.close();
    return "";
  }
}
