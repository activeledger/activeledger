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

import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Activity } from "@activeledger/activecontracts";
import { QueryEngine, EventEngine } from "@activeledger/activequery";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { setTimeout } from "timers";
import { NodeVM } from "vm2";

/**
 * Contract Virtual Machine Controller
 *
 * @export
 * @class VirtualMachine
 */
export class VirtualMachine {
  /**
   * Virtual Machine Object
   *
   * @private
   * @type {VM}
   * @memberof VirtualMachine
   */
  private virtual: NodeVM;

  /**
   * Give Access to Export routine
   *
   * @private
   * @type {number}
   * @memberof VirtualMachine
   */
  private key: number;

  /**
   * Holds the event engine
   *
   * @private
   * @type {EventEngine}
   * @memberof VirtualMachine
   */
  private event: EventEngine;

  /**
   * When this VM timeout can not be extended past.
   *
   * @private
   * @type {Date}
   * @memberof VirtualMachine
   */
  private maxTimeout: Date;

  /**
   * Script execution status
   *
   * @private
   * @type {boolean}
   * @memberof VirtualMachine
   */
  private scriptFinishedExec: boolean = false;

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
   * @param {ActiveCrypto.Secured} secured
   * @memberof VirtualMachine
   */
  constructor(
    private contractPath: string,
    private selfHost: string,
    private umid: string,
    private cdate: Date,
    private remoteAddr: string,
    private tx: ActiveDefinitions.LedgerTransaction,
    private sigs: ActiveDefinitions.LedgerSignatures,
    private inputs: ActiveDefinitions.LedgerStream[],
    private outputs: ActiveDefinitions.LedgerStream[],
    private reads: ActiveDefinitions.LedgerIORputs,
    private db: ActiveDSConnect,
    private dbev: ActiveDSConnect,
    private secured: ActiveCrypto.Secured
  ) {
    // Setup Event Engine
    this.event = new EventEngine(this.dbev, this.tx.$contract);
  }

  /**
   * Extract All changed streams
   *
   * @returns {{ [reference: string]: Activity }}
   * @memberof VirtualMachine
   */
  public getActivityStreamsFromVM(): ActiveDefinitions.LedgerStream[] {
    // Fetch Activities and prepare to check
    let activities: {
      [reference: string]: Activity;
    } = this.virtual.run("return sc.getActivityStreams();", "avm.js");
    let streams: string[] = Object.keys(activities);
    let i = streams.length;

    // The exported streams with changes
    let exported: ActiveDefinitions.LedgerStream[] = [];

    // Loop each stream and find the marked ones
    while (i--) {
      if (activities[streams[i]].updated) {
        exported.push(activities[streams[i]].export2Ledger(this.key));
      }
    }
    return exported;
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   * @memberof VirtualMachine
   */
  public getInternodeCommsFromVM(): any {
    return this.virtual.run("return sc.getThisInterNodeComms();", "avm.js");
  }

  /**
   * Are we suppose to clear the node comms
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public clearingInternodeCommsFromVM(): boolean {
    return this.virtual.run("return sc.getClearInterNodeComms()", "avm.js");
  }

  /**
   * Data to send back to the requesting http client
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public getReturnContractData(): boolean {
    return this.virtual.run("return sc.getReturnToRemote()", "avm.js");
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   * @memberof VirtualMachine
   */
  public getThrowsFromVM(): string[] {
    return this.virtual.run("return sc.throwTo;", "avm.js");
  }

  /**
   * Get current working inputs of the contract (External to VM)
   *
   * @returns {ActiveDefinitions.LedgerStream[]}
   * @memberof VirtualMachine
   */
  public getInputs(): ActiveDefinitions.LedgerStream[] {
    return this.inputs;
  }

  /**
   * Dynamically import the contract. Currently object is created outside VM and set as a global
   *
   * @returns {Promise<boolean>}
   * @memberof VirtualMachine
   */
  public initalise(): Promise<boolean> {
    // Return as promise for initalise
    return new Promise((resolve, reject) => {
      try {
        // Set Secret Key
        this.key = Math.floor(Math.random() * 100);

        // Toolkit Availability Check
        let toolkitAvailable = true;
        try {
          require.resolve("@_activeledger/activetoolkits");
        } catch (error) {
          // Toolkits not installed
          toolkitAvailable = false;
        }

        // Manage Externals & buildit
        let external: string[] = [
          this.contractPath,
          "@activeledger/activecontracts"
        ];
        let builtin: string[] = ["buffer"];

        // With toolkit allow additional externals & builtin
        if (toolkitAvailable) {
          external.push(
            "@activeledger/activeutilities",
            "@_activeledger/activetoolkits"
          );
          builtin.push("events", "http", "https", "url", "zlib");
        }

        // Add additional External & builtin by namespace
        if (this.tx.$namespace == "default") {
          switch (this.tx.$contract) {
            case "contract":
              external.push("typescript");
              builtin.push("fs", "path", "os", "crypto");
              break;
            case "setup":
              builtin.push("fs", "path");
              break;
          }
        } else {
          // Now check configuration for allowed standard libs for this namespace
          let security = ActiveOptions.get<any>("security", {});

          // Check to see if this namespace exists
          if (security.namespace && security.namespace[this.tx.$namespace]) {
            security.namespace[this.tx.$namespace].std.forEach(
              (item: string) => {
                // Add to builtin VM
                builtin.push(item);
              }
            );
          }
        }

        // Import Contract
        // Create limited VM
        this.virtual = new NodeVM({
          wrapper: "none",
          sandbox: {
            logger: ActiveLogger,
            crypto: ActiveCrypto,
            secured: this.secured,
            query: new QueryEngine(this.db, true),
            event: this.event,
            contractPath: this.contractPath,
            umid: this.umid,
            cdate: new Date(this.cdate), // + copy of date has random issues
            remoteAddr: this.remoteAddr,
            tx: JSON.parse(JSON.stringify(this.tx)), // Deep Copy (Isolated, But We can still access if needed)
            sigs: this.sigs,
            inputs: this.inputs,
            outputs: this.outputs,
            reads: this.reads,
            key: this.key,
            self: this.selfHost
          },
          require: {
            context: "sandbox",
            builtin,
            external
          }
        });

        // Intalise Contract into VM (Will need to make sure require is not used and has been fully locked down)
        this.virtual.run(
          "global.sc = new (require(contractPath)).default(cdate, remoteAddr, umid, tx, inputs, outputs, reads, sigs, key, self);",
          "avm.js"
        );

        // Do they want the query engine
        this.virtual.run(
          `if("setQuery" in sc) { sc.setQuery(query) }`,
          "avm.js"
        );

        // Do they want the event engine
        this.virtual.run(
          `if("setEvent" in sc) { sc.setEvent(event) }`,
          "avm.js"
        );

        // Default Namespace can accept config, Could just read the file
        // However when it comes to working from the ledger it will be in memory anyway
        if (this.tx.$namespace == "default") {
          this.virtual.run(
            `if("sysConfig" in sc) { sc.sysConfig(${JSON.stringify(
              ActiveOptions.fetch(false)
            )}) }`,
            "avm.js"
          );
        }

        // Start time initialise the date object
        this.maxTimeout = new Date();

        // Convert to max timeout date (Minutes converted to milliseconds)
        this.maxTimeout.setMilliseconds(
          ActiveOptions.get<number>("contractMaxTimeout", 20) * 60 * 1000
        );

        // Continue
        resolve(true);
      } catch (e) {
        if (e instanceof Error) {
          // Exception
          reject(this.catchException(e));
        }
      }
    });
  }

  /**
   * Run verify part of the smart contract
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public verify(sigless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("verify");

      // Manage Timeout
      this.checkTimeout("verify", () => {
        reject("VM Error : Verify phase timeout");
      });

      // Run Verify Phase
      (this.virtual.run(`return sc.verify(${sigless})`, "avm.js") as Promise<
        boolean
      >)
        .then(() => {
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch(e => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Run vote part of the smart contract
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("vote");

      // Manage Timeout
      this.checkTimeout("vote", () => {
        reject("VM Error : Vote phase timeout");
      });

      // Run Vote Phase
      (this.virtual.run(`return sc.vote()`, "avm.js") as Promise<boolean>)
        .then(() => {
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch(e => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Run commit part of the smart contract
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   * @memberof VirtualMachine
   */
  public commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean = false
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes);

      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("commit");

      // Manage Timeout
      this.checkTimeout("commit", () => {
        reject("VM Error : Commit phase timeout");
      });

      // Get Commit
      (this.virtual.run(
        `return sc.commit(${possibleTerritoriality})`,
        "avm.js"
      ) as Promise<any>)
        .then(() => {
          // Here we may update the database from the objects (commit should return)
          // Or just manipulate / check the outputs
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch(e => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Do something after the commit phase, Territoriality is if this is the first post commit
   * running in the entire network
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof VirtualMachine
   */
  public postProcess(territoriality: boolean, who: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("post");

      // Manage Timeout
      this.checkTimeout("post", () => {
        reject("VM Error : Post phase timeout");
      });

      // Run Post Process
      (this.virtual.run(
        `if("postProcess" in sc) { 
            // Run Post Process
            return sc.postProcess(${territoriality}, "${who}");
          }else{
            // Auto Resolve if no post process
            return new Promise((resolve, reject) => {
              resolve(true);
            });
          } `,
        "avm.js"
      ) as Promise<any>)
        .then(postProcess => {
          // Do something with the returned value
          // Maybe resolve with the data
          this.scriptFinishedExec = true;

          // Reload Configuration Required?
          if (this.tx.$namespace == "default") {
            if (
              this.virtual.run(
                `if("sysConfig" in sc) { return sc.configReload() }else{ return false; }`,
                "avm.js"
              )
            ) {
              ActiveLogger.info("Reloading Configuration Request");
              // Can Moan in process (No need network)
              (process as any).send({
                type: "reload"
              });
            }
          }
          resolve(postProcess);
        })
        .catch(e => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Marshel the INcomms into the contract
   *
   * @private
   * @param {ActiveDefinitions.INodes} nodes
   * @memberof VirtualMachine
   */
  private incMarshel(nodes: ActiveDefinitions.INodes): void {
    // Get Node Keys (Or get from Neighbourhood?)
    let keys = Object.keys(nodes);
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
        this.virtual.freeze(comms, "INC");
      }
    }
  }

  /**
   * Check the VM has or hasn't timedout
   *
   * @private
   * @param {string} type
   * @param {Function} timedout
   * @memberof VirtualMachine
   */
  private checkTimeout(type: string, timedout: Function): void {
    // Setup Timeout Ticket
    setTimeout(() => {
      // Has the script not finished
      if (!this.scriptFinishedExec) {
        // Has it extended its timeout
        if (!this.hasBeenExtended()) {
          // Hasn't been extended so call function
          timedout();
        } else {
          // Check again later
          this.checkTimeout(type, timedout);
        }
      }
    }, ActiveOptions.get<number>("contractCheckTimeout", 10000));
  }

  /**
   * Detect if the script is within timeout limits
   *
   * @private
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  private hasBeenExtended(): boolean {
    // Fetch new time out request from the contract
    let timeoutRequestTime = this.virtual.run(
      `return sc.getTimeout()`,
      "avm.js"
    );

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
   * @memberof VirtualMachine
   */
  private catchException(e: Error): any {
    // Exception
    if (e.stack) {
      // Get Current Contract Filename only
      const contract = this.contractPath.substr(
        this.contractPath.lastIndexOf("/") + 1
      );

      // Find Contract Code in Stacktrace
      const contractErrorLine = e.stack.match(
        new RegExp(`^.*${contract}.*$`, "m")
      );

      // Was our contract in the stack trace
      if (contractErrorLine && contractErrorLine.length) {
        // Get First Match
        const contractLastCallLine = contractErrorLine[0].trim();

        // Find Contract Start
        const lastIndexFolder = contractLastCallLine.indexOf(contract) + 1;

        // Extract Contract + Line Numbers
        let contractErrorInfo = contractLastCallLine.substring(
          lastIndexFolder,
          contractLastCallLine.length
        );

        return {
          error: e.message,
          at: contractErrorInfo
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
        msg =
          this.contractPath.substr(this.contractPath.lastIndexOf("/") + 1) +
          ":" +
          msg.substr(msg.indexOf(".js") + 4);

        //return reject(e.message + "@" + msg);
        return {
          error: e.message,
          at: msg
        };
      }
    } else {
      return e.message;
    }
  }
}
