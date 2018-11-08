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
import { EventEmitter } from "events";
import { VirtualMachine } from "./vm";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";

/**
 * Class controls the processing of this nodes consensus
 *
 * @export
 * @class Process
 * @extends {EventEmitter}
 */
export class Process extends EventEmitter {
  /**
   * Hosts the VM instance
   *
   * @private
   * @type {VirtualMachine}
   * @memberof Process
   */
  private contractVM: VirtualMachine;

  /**
   * Holds string reference of inputs streams
   *
   * @private
   * @type {string[]}
   * @memberof Process
   */
  private inputs: string[];

  /**
   * Holds string reference of output streams
   *
   * @private
   * @type {string[]}
   * @memberof Process
   */
  private outputs: string[];

  /**
   * Flag for checking or setting revisions
   *
   * @private
   * @type {boolean}
   * @memberof Process
   */
  private checkRevs: boolean = true;

  /**
   * Contains reference to this nodes node response
   *
   * @private
   * @type {ActiveDefinitions.INodeResponse}
   * @memberof Process
   */
  private nodeResponse: ActiveDefinitions.INodeResponse;

  /**
   * Default Contracts & Compiled Contracts are in differntlocations
   *
   * @private
   * @type {string}
   * @memberof Process
   */
  private contractLocation: string;

  /**
   * Commiting State
   *
   * @private
   * @memberof Process
   */
  private commiting = false;

  /**
   * Creates an instance of Process.
   * Creates an instance of Process.
   * right:any temporarily resolves ciruclar reference.
   * ActiveNetwork.Home.Right is its source.
   * TODO: Solve the reference
   *
   * @param {ActiveDefinitions.LedgerEntry} entry
   * @param {string} selfHost
   * @param {string} reference
   * @param {*} right
   * @param {PouchDB} db
   * @param {PouchDB} error
   * * @param {PouchDB} events
   * @memberof Process
   */
  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private selfHost: string,
    private reference: string,
    private right: any,
    private db: any,
    private dbe: any,
    private dbev: any
  ) {
    super();

    // Reference node response
    this.nodeResponse = entry.$nodes[reference];
  }

  /**
   * Starts the consensus and commit phase processing
   *
   * @memberof Process
   */
  public async start() {
    //TODO: Have a queue?
    ActiveLogger.info(this.entry, "Starting TX");

    // Temporary Solution for mixed paths
    let prefix: string = "";

    // Compiled Contracts sit in another location
    if (this.entry.$tx.$namespace == "default") {
      // Default Contract Location
      this.contractLocation = `${ActiveOptions.get("__base", "./")}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`;
    } else {
      // Ledger Transpiled Contract Location
      this.contractLocation = `${process.cwd()}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`;
    }

    // Get contract file (Or From Database)
    if (fs.existsSync(prefix + this.contractLocation)) {
      // Now we know we can execute the contract now or more costly cpu checks
      ActiveLogger.debug("Fetching Inputs");

      // Build Inputs Key Maps (Reference is Stream)
      this.inputs = Object.keys(this.entry.$tx.$i || {});

      // We must have inputs (New Inputs can create brand new unknown outputs)
      if (!this.inputs.length)
        this.raiseLedgerError(1101, new Error("Inputs cannot be null"));

      // Build Outputs Key Maps (Reference is Stream)
      ActiveLogger.debug("Fetching Outputs");
      this.outputs = Object.keys(this.entry.$tx.$o || {});

      // Are we checking revisions or setting?
      if (!this.entry.$revs) {
        this.checkRevs = false;
        this.entry.$revs = {
          $i: {},
          $o: {}
        };
      }

      // If Signatureless transaction (Such as a new account there cannot be a revision)
      if (!this.entry.$selfsign) {
        // Prefixes
        // [umid] : Holds the data state (Prefix may be removed)
        // [umid]:stream : Activeledger Meta Data
        // [umid]:volatile : Data that can be lost

        // Check the input revisions
        this.permissionsCheck()
          .then((inputStreams: ActiveDefinitions.LedgerStream[]) => {
            // Check the output revisions
            this.permissionsCheck(false)
              .then((outputStreams: ActiveDefinitions.LedgerStream[]) => {
                this.process(inputStreams, outputStreams);
              })
              .catch(error => {
                // Forward Error On
                //this.raiseLedgerError(error.code, error.error, true);
                // We may not have the output stream, So we need to pass over the knocks
                this.postVote({
                  code: error.code,
                  reason: error.reason || error.message
                });
              });
          })
          .catch(error => {
            // Forward Error On
            //this.raiseLedgerError(error.code, error.error, true);
            // We may not have the input stream, So we need to pass over the knocks
            this.postVote({
              code: error.code,
              reason: error.reason || error.message
            });
          });
      } else {
        ActiveLogger.debug("Self signed Transaction");

        // If there are sigs we can enforce for the developer
        let sigs = Object.keys(this.entry.$sigs);
        if (sigs.length > 0) {
          // Loop Signatures and match against inputs
          let i = sigs.length;
          while (i--) {
            let signature = this.entry.$sigs[sigs[i]];
            let input = this.entry.$tx.$i[sigs[i]];

            // Make sure we have an input (Can Skip otherwise maybe onboarded)
            if (input) {
              // Check the input has a public key
              if (input.publicKey) {
                if (
                  !this.signatureCheck(
                    input.publicKey,
                    signature,
                    input.type ? input.type : "rsa"
                  )
                ) {
                  return this.raiseLedgerError(
                    1250,
                    new Error("Self signed signature not matching")
                  );
                }
              } else {
                // We don't have the public key to check
                return this.raiseLedgerError(
                  1255,
                  new Error(
                    "Self signed publicKey property not found in $i " + sigs[i]
                  )
                );
              }
            } else {
              return this.raiseLedgerError(
                1245,
                new Error("Self signed signature missing input pairing")
              );
            }
          }
        }

        // No input streams, Maybe Output
        this.permissionsCheck(false)
          .then((outputStreams: ActiveDefinitions.LedgerStream[]) => {
            this.process([], outputStreams);
          })
          .catch(error => {
            // Forward Error On
            this.postVote({
              code: error.code,
              reason: error.reason || error.message
            });
          });
      }
    } else {
      // Contract not found
      this.raiseLedgerError(1404, new Error("Contract Not Found"));
    }
  }

  /**
   * Updates VM transaction entry from other node broadcasts
   *
   * @param {*} node
   * @memberof Process
   */
  public updatedFromBroadcast(node: any): void {
    // Update networks response into local object
    this.entry.$nodes = Object.assign(this.entry.$nodes, node);

    // Make sure we haven't already reached consensus
    if(!this.isCommiting()) {
      // Try run commit!
      this.commit();
    }
  }

  /**
   * Returns Commiting State (Broadcast)
   *
   * @returns {boolean}
   * @memberof Process
   */
  public isCommiting(): boolean {
    return this.commiting;
  }

  /**
   * Returns Commiting State (Broadcast)
   *
   * @returns {boolean}
   * @memberof Process
   */
  public isCommiting(): boolean {
    return this.commiting;
  }

  /**
   * Processes the transaction through the contract phases
   * Verify, Vote, Commit.
   * Vote phase is in memory blocked during conensus unless instant transaction
   *
   * @private
   * @param {LedgerStream[]} inputs
   * @memberof Process
   */
  private process(inputs: ActiveDefinitions.LedgerStream[]): void;
  private process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[]
  ): void;
  private process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[] = []
  ): void {
    this.getReadOnlyStreams()
      .then(readonly => {
        // We don't need to verify the code unless we suspect server has been
        // comprimised. We will verify with the "install" routine
        // TODO: Fix temp path solution (Param? PATH? Global?)
        this.contractVM = new VirtualMachine(
          this.contractLocation,
          this.selfHost,
          this.entry.$umid,
          this.entry.$tx,
          this.entry.$sigs,
          inputs,
          outputs,
          readonly,
          this.db,
          this.dbev
        );

        // Initalise contract VM
        this.contractVM
          .initalise()
          .then(() => {
            // Verify Transaction details in the contract
            // Also allow the contract to verify it likes signatureless transactions
            this.contractVM
              .verify(this.entry.$selfsign)
              .then(() => {
                // Get Vote (May change to string as it can contain the reason)
                // Or in the VM we can catch any thrown errors messages
                this.contractVM
                  .vote()
                  .then(() => {
                    // Update Vote Entry
                    this.nodeResponse.vote = true;

                    // Internode Communication picked up here, Doesn't mean every node
                    // Will get all values (Early send back) but gives the best chance of getting most of the nodes communicating
                    this.nodeResponse.incomms = this.contractVM.getInternodeCommsFromVM();

                    // Continue to next nodes vote
                    this.postVote();
                  })
                  .catch(error => {
                    // Vote failed (Not and error continue casting vote on the network)
                    ActiveLogger.debug(error, "Vote Failure");

                    // Update errors
                    this.storeError(1000, new Error("Vote Failure"))
                      .then(() => {
                        // Continue Execution of consensus
                        // Update Error
                        this.nodeResponse.error = error;

                        // Continue to next nodes vote
                        this.postVote();
                      })
                      .catch(error => {
                        // Continue Execution of consensus even with this failing
                        // Just add a fatal message
                        ActiveLogger.fatal(error, "Voting Error Log Issues");

                        // Update Error
                        this.nodeResponse.error = error;

                        // Continue to next nodes vote
                        this.postVote();
                      });
                  });
              })
              .catch(error => {
                ActiveLogger.debug(error, "Verify Failure");
                // Verification Failure
                this.raiseLedgerError(1310, new Error(error));
              });
          })
          .catch(e => {
            ActiveLogger.debug(e, "VM Failure" + __dirname);
            // Contract not found
            this.raiseLedgerError(1401, new Error("Virtual Machine Failure"));
          });
      })
      .catch(e => {
        // error fetch read only streams
        this.raiseLedgerError(1210, new Error("Read Only Stream Error"));
      });
  }

  /**
   * Manages the protocol process after this node has voted
   *
   * @private
   * @memberof Process
   */
  private postVote(error: any = false): void {
    // Instant Transaction Return right away
    if (!error && this.entry.$instant) {
      this.emit("commited", { instant: true });
      // Rewrite trasnaction to no longer be instant for standard background consensus
      this.entry.$instant = false;
    }

    if (this.entry.$broadcast) {
      if (!error) {
        // Let all other nodes know about this transaction and our opinion
        this.emit("broadcast", this.entry);
      }
    } else {
      // Knock our right neighbour with this trasnaction if they are not the origin
      if (this.right.reference != this.entry.$origin) {
        // Send back early if consensus has been reached and not the end of the network
        // (Early commit, Then Forward to network)
        this.commit(() => {
          this.right
            .knock("init", this.entry)
            .then((response: any) => {
              // Territoriality set?
              this.entry.$territoriality = (response.data as ActiveDefinitions.LedgerEntry).$territoriality;
              // Append new $nodes
              this.entry.$nodes = (response.data as ActiveDefinitions.LedgerEntry).$nodes;

              // Reset Reference node response
              this.nodeResponse = this.entry.$nodes[this.reference];

              // Normal, Or getting other node opinions?
              if (error) {
                this.raiseLedgerError(error.code, error.reason, true);
              }

              // Run the Commit Phase
              this.commit();
            })
            .catch((error: any) => {
              // Need to manage errors this would mean the node is unreachable
              // TODO : Maybe issue a "rebase" of the network here?
              ActiveLogger.debug(error, "Knock Failure");

              // if debug mode forward
              // IF error has status and error this came from another node which has erroed (not unreachable)
              if (ActiveOptions.get<boolean>("debug", false)) {
                // rethrow same error
                this.raiseLedgerError(
                  error.status || 1502,
                  new Error(error.error)
                );
              } else {
                // Generic error 404/ 500
                this.raiseLedgerError(1501, new Error("Bad Knock Transaction"));
              }
            });
        });
      } else {
        ActiveLogger.debug("Origin is next (Sending Back)");
        if (error) {
          // Ofcourse if next is origin we need to send back for the promises!
          this.raiseLedgerError(error.code, error.reason);
        } else {
          // Run the Commit Phase
          this.commit();
        }
      }
    }
  }

  /**
   * Decides if consensus has been reached for commit phase to start
   *
   * @private
   * @returns {boolean}
   * @memberof Process
   */
  private canCommit(): boolean {
    // Time to count the votes (Need to recache keys)
    let networkNodes: string[] = Object.keys(this.entry.$nodes);
    let i = networkNodes.length;
    let votes = 0;

    // Small performance boost if we voted no
    if (this.nodeResponse.vote) {
      while (i--) {
        if (this.entry.$nodes[networkNodes[i]].vote) votes++;
      }
    }

    // Return if consensus has been reached
    return (
      (this.nodeResponse.vote &&
        (votes / ActiveOptions.get<Array<any>>("neighbourhood", []).length) *
          100 >=
          ActiveOptions.get<any>("consensus", {}).reached) ||
      false
    );
  }

  /**
   * Checks voting round and runs the commit phase of the contract
   * The use of callback is because it fits better than a promise in the flow and the performance is a bonus
   *
   * @private
   * @param {() => void} [earlyCommit]
   * @returns {void}
   * @memberof Process
   */
  private commit(earlyCommit?: () => void): void {
    // If we haven't commited process as normal
    if (!this.nodeResponse.commit) {
      // check we can commit still
      if (this.canCommit()) {
        // Consensus reached commit phase
        this.commiting = true;
        // Pass Nodes for possible INC injection
        this.contractVM
          .commit(this.entry.$nodes, !this.entry.$territoriality)
          .then(commit => {
            // Update Commit Entry
            this.nodeResponse.commit = true;

            // Update in communication (Recommended pre commit only but can be edge use cases)
            this.nodeResponse.incomms = this.contractVM.getInternodeCommsFromVM();

            // Are we throwing to another ledger(s)?
            let throws = this.contractVM.getThrowsFromVM();

            // Emit to network handler
            if (throws && throws.length) {
              this.emit("throw", { locations: throws });
            }

            // Get the changed data streams
            let streams: ActiveDefinitions.LedgerStream[] = this.contractVM.getActivityStreamsFromVM();

            // Get current working inputs to compare and update if not modified above
            let inputs: ActiveDefinitions.LedgerStream[] = this.contractVM.getInputs();

            let skip: string[] = [];

            // Determanistic Collision Managamenent
            let collisions = [];

            // Any Changes
            if (streams.length) {
              // Process Changes to the database
              // Bulk Insert Docs
              let docs: any[] = [];

              // Loop Streams
              let i = streams.length;
              while (i--) {
                // New or Updating?
                if (!streams[i].meta._rev) {
                  // Make sure we have an id
                  if (!streams[i].meta._id) {
                    // New (Need to set ids)
                    streams[i].state._id = this.entry.$umid + i;
                    streams[i].meta._id = streams[i].state._id + ":stream";
                    streams[i].volatile._id =
                      streams[i].state._id + ":volatile";
                  }

                  // if it is sigless
                  // Need to add transaction to all meta documents
                  if (this.entry.$selfsign) {
                    streams[i].meta.txs = [this.compactTxEntry()];
                    // Also set as intalisiser stream (stream constructor)
                    streams[i].meta.$constructor = true;
                  }

                  // Need to remove rev
                  delete streams[i].state._rev;
                  delete streams[i].meta._rev;
                  delete streams[i].volatile._rev;

                  // New Streams need to check if collision will happen
                  if (streams[i].meta.umid !== this.entry.$umid) {
                    collisions.push(streams[i].meta._id);
                  }
                } else {
                  // Updated Streams, These could be inputs
                  // So update the transaction and remove for inputs for later processing
                  if (streams[i].meta.txs && streams[i].meta.txs.length) {
                    streams[i].meta.txs.push(this.compactTxEntry());
                    skip.push(streams[i].meta._id as string);
                  }

                  // Hardened Keys?
                  if (
                    streams[i].state._id &&
                    ActiveOptions.get<any>("security", {}).hardenedKeys
                  ) {
                    streams[i].meta.public = this.entry.$tx.$i[
                      streams[i].state._id as string
                    ].$nhpk;
                  }
                }

                // TODO: Somehow we are getting an empty doc for now we will check on empty null

                // Push Docs (Need to change null to undefined)

                // Data State (Developers Control)
                if (streams[i].state._id) docs.push(streams[i].state);

                // Meta (Stream Data) for internal usage
                if (streams[i].meta._id) docs.push(streams[i].meta);

                // Volatile data which cannot really be trusted
                if (streams[i].volatile._id) docs.push(streams[i].volatile);
              }

              // Any inputs left (Means not modified)
              // Now we need to append transaction to the inputs of the transaction
              if (inputs && inputs.length) {
                // Add to all docs
                let i = inputs.length;
                while (i--) {
                  if (
                    skip.indexOf(inputs[i].meta._id as string) === -1 &&
                    inputs[i].meta.txs &&
                    inputs[i].meta.txs.length
                  ) {
                    // Add Compact Transaction
                    inputs[i].meta.txs.push(this.compactTxEntry());

                    // Hardened Keys?
                    if (
                      inputs[i].state._id &&
                      ActiveOptions.get<any>("security", {}).hardenedKeys
                    ) {
                      streams[i].meta.public = this.entry.$tx.$i[
                        inputs[i].state._id as string
                      ].$nhpk;
                    }

                    // Push to docs (Only Meta)
                    docs.push(inputs[i].meta);
                  }
                }
              }

              /**
               * Delegate Function
               * Attempt to atomicaly save to the datastore
               * Allow for delay execution for deterministic test
               */
              let append = () => {
                this.db
                  .bulkDocs(docs)
                  .then((response: any) => {
                    // Set datetime to reflect when data is set from memory to disk
                    this.nodeResponse.datetime = new Date();

                    // Were we first?
                    if (!this.entry.$territoriality)
                      this.entry.$territoriality = this.reference;

                    // If Origin Explain streams in output
                    if (this.reference == this.entry.$origin) {
                      this.entry.$streams = {
                        new: [],
                        updated: []
                      };

                      // Loop the docs again
                      let i = streams.length;
                      while (i--) {
                        // New has no _rev
                        if (!streams[i].meta._rev) {
                          this.entry.$streams.new.push({
                            id: streams[i].state._id as string,
                            name: streams[i].meta.name as string
                          });
                        } else {
                          this.entry.$streams.updated.push({
                            id: streams[i].state._id as string,
                            name: streams[i].meta.name as string
                          });
                        }
                      }
                    }

                    // Manage Post Processing (If Exists)
                    this.contractVM
                      .postProcess(
                        this.entry.$territoriality == this.reference
                          ? true
                          : false,
                        this.entry.$territoriality
                      )
                      .then(post => {
                        this.nodeResponse.post = post;

                        // Update in communication (Recommended pre commit only but can be edge use cases)
                        this.nodeResponse.incomms = this.contractVM.getInternodeCommsFromVM();

                        // Remember to let other nodes know
                        if (earlyCommit) return earlyCommit();
                        this.emit("commited", { tx: this.compactTxEntry() });
                      })
                      .catch(error => {
                        // Don't let local error stop other nodes
                        if (earlyCommit) return earlyCommit();
                        // Ignore errors for now, As commit was still a success
                        this.emit("commited", { tx: this.compactTxEntry() });
                      });
                  })
                  .catch((error: Error) => {
                    // Don't let local error stop other nodes
                    if (earlyCommit) return earlyCommit();
                    ActiveLogger.debug(error, "Datatore Failure");
                    this.raiseLedgerError(1510, new Error("Failed to save"));
                  });
              };

              // The documents to be stored
              // ActiveLogger.debug(docs, "Changed Documents");

              // Detect Collisions
              if (collisions.length) {
                ActiveLogger.info("Deterministic streams to be checked");

                // Store the promises to wait on.
                let streamColCheck: any[] = [];

                // Loop all streams
                collisions.forEach((streamId: string) => {
                  // Query datastore for streams
                  streamColCheck.push(this.db.get(streamId));
                });

                // Wait for all checks
                Promise.all(streamColCheck)
                  .then(streams => {
                    // Problem Streams Exist
                    ActiveLogger.debug(
                      streams,
                      "Deterministic Stream Name Exists"
                    );
                    // Update commit
                    this.nodeResponse.commit = false;
                    this.raiseLedgerError(
                      1530,
                      new Error("Deterministic Stream Name Exists")
                    );
                  })
                  .catch(() => {
                    // Continue (Error being document not found)
                    append();
                  });
              } else {
                // Continue
                append();
              }
            } else {
              // Nothing to store which is _no longer_ strange contract may not make changes!
              // Were we first?
              if (!this.entry.$territoriality)
                this.entry.$territoriality = this.reference;

              // Manage Post Processing (If Exists)
              this.contractVM
                .postProcess(
                  this.entry.$territoriality == this.reference ? true : false,
                  this.entry.$territoriality
                )
                .then(post => {
                  this.nodeResponse.post = post;

                  // Update in communication (Recommended pre commit only but can be edge use cases)
                  this.nodeResponse.incomms = this.contractVM.getInternodeCommsFromVM();

                  // Remember to let other nodes know
                  if (earlyCommit) return earlyCommit();
                  this.emit("commited", { tx: this.compactTxEntry() });
                })
                .catch(error => {
                  // Don't let local error stop other nodes
                  if (earlyCommit) return earlyCommit();
                  // Ignore errors for now, As commit was still a success
                  this.emit("commited", { tx: this.compactTxEntry() });
                });
            }
          })
          .catch(error => {
            // Don't let local error stop other nodes
            if (earlyCommit) return earlyCommit();
            ActiveLogger.debug(error, "VM Commit Failure");

            // If debug mode forward full error
            if (ActiveOptions.get<boolean>("debug", false)) {
              this.raiseLedgerError(1302, new Error(error.message));
            } else {
              this.raiseLedgerError(
                1301,
                new Error("Failed Commit Transaction")
              );
            }
          });
      } else {
        // If Early commit we don't need to manage these errors
        if (earlyCommit) return earlyCommit();
        // Consensus not reached
        if (!this.nodeResponse.vote) {
          // We didn't vote right
          ActiveLogger.debug("VM Commit Failure, We voted NO");

          // Because we voted no doesn't mean the network should error
          this.emit("commited", {});
        } else {
          // Network didn't reach consensus
          ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
          this.raiseLedgerError(1510, new Error("Failed Network Voting Round"));
        }
      }
    } else {
      // We have committed do nothing.
      // Headers should be sent already but just in case emit commit
      if (earlyCommit) earlyCommit();
      this.emit("commited", {});
    }
  }

  /**
   * Manages the permissions of revisions and signatures of each stream type
   * TODO: Implement M of N key check
   *
   * @private
   * @param {string[]} check
   * @returns {Promise<any>}
   * @memberof Process
   */
  private permissionsCheck(inputs: boolean = true): Promise<any> {
    // Backwards compatibile will need to be managed here as stream wont exist
    // Then on "commit" phase we can create the stream file for this to work

    // Test the right object
    let check = this.inputs;
    if (!inputs) check = this.outputs;

    // Return as promise for execution
    return new Promise((resolve, reject) => {
      // Process all promises at "once"
      Promise.all(
        // Map all the objects to get their promises
        check.map(item => {
          // Create promise to manage all revisions at once
          return new Promise((resolve, reject) => {
            // Get Meta data
            this.db
              .get(item + ":stream")
              .then((meta: any) => {
                // Check Script Lock
                let iMeta: ActiveDefinitions.IMeta = meta as ActiveDefinitions.IMeta;
                if (
                  iMeta.contractlock &&
                  iMeta.contractlock.length &&
                  iMeta.contractlock.indexOf(this.entry.$tx.$contract) === -1
                ) {
                  // We have a lock but not for the current contract request
                  return reject({
                    code: 1700,
                    reason: "Stream contract locked"
                  });
                }
                // Check Namespace Lock
                if (
                  iMeta.namespaceLock &&
                  iMeta.namespaceLock.length &&
                  iMeta.namespaceLock.indexOf(this.entry.$tx.$namespace) === -1
                ) {
                  // We have a lock but not for the current contract request
                  return reject({
                    code: 1710,
                    reason: "Stream namespace locked"
                  });
                }

                // Got the meta, Now for real stream
                this.db
                  .get(item)
                  .then((state: any) => {
                    // Got the state now for volatile
                    this.db
                      .get(item + ":volatile")
                      .then((volatile: any) => {
                        // Resolve the whole stream
                        resolve({
                          meta: meta,
                          state: state,
                          volatile: volatile
                        });
                      })
                      .catch((error: any) => {
                        // TODO : Is this a problem? Can we resolve?
                        // Add Info
                        error.code = 960;
                        error.reason = "Volatile not found";
                        // Rethrow
                        reject(error);
                      });
                  })
                  .catch((error: any) => {
                    // Add Info
                    error.code = 960;
                    error.reason = "State not found";
                    // Rethrow
                    reject(error);
                  });
              })
              .catch((error: any) => {
                // Add Info
                error.code = 950;
                error.reason = "Stream not found";
                // Rethrow
                reject(error);
              });
          });
        })
      )
        // Now have all the streams to process from the database
        .then((stream: ActiveDefinitions.LedgerStream[]) => {
          // All streams documents, May need to convert to promises but all this code is sync
          let i = stream.length;
          while (i--) {
            // Quick Reference
            let streamId: string = (stream[i].meta as any)._id as string;

            // Remove :stream
            streamId = streamId.substring(0, streamId.length - 7);

            // Get Revision type
            let revType = this.entry.$revs.$i;
            if (!inputs) revType = this.entry.$revs.$o;

            // Check or set Revisions
            if (this.checkRevs) {
              if (
                revType[streamId] !==
                (stream[i].meta._rev as any) +
                  ":" +
                  (stream[i].state._rev as any)
              )
                // Break loop and reject
                return reject({
                  code: 1200,
                  reason:
                    (inputs ? "Input" : "Output") + " Stream Position Incorrect"
                });
            } else {
              revType[streamId] =
                (stream[i].meta._rev as any) +
                ":" +
                (stream[i].state._rev as any);
            }

            // Signature Check & Hardened Keys (Inputs and maybe Outputs based on configuration)
            if (
              inputs ||
              ActiveOptions.get<any>("security", {}).signedOutputs
            ) {
              // Check to see if key hardening is enabled and done
              if (ActiveOptions.get<any>("security", {}).hardenedKeys) {
                let checks = inputs ? this.entry.$tx.$i : this.entry.$tx.$o;
                if (!checks[streamId].$nhpk)
                  return reject({
                    code: 1230,
                    reason:
                      (inputs ? "Input" : "Output") +
                      " Security Hardened Key Transactions Only"
                  });
              }

              // Now can check signature
              if (
                !this.signatureCheck(
                  (stream[i].meta as any).public,
                  this.entry.$sigs[streamId],
                  (stream[i].meta as any).type
                    ? (stream[i].meta as any).type
                    : "rsa"
                )
              )
                // Break loop and reject
                return reject({
                  code: 1220,
                  reason: (inputs ? "Input" : "Output") + " Signature Incorrect"
                });
            }
          }
          // Everything is good
          resolve(stream);
        })
        .catch(error => {
          // Rethrow error
          reject(error);
        });
    });
  }

  /**
   * Fetches streams for read only consumption
   *
   * @private
   * @returns {Promise<boolean>}
   * @memberof Process
   */
  private getReadOnlyStreams(): Promise<ActiveDefinitions.LedgerIORputs> {
    return new Promise((resolve, reject) => {
      // Holds the read only stream data
      let readonlyStreams: ActiveDefinitions.LedgerIORputs = {};

      if (this.entry.$tx.$r) {
        // Reference for solving linter errors
        let readOnly = this.entry.$tx.$r;
        // Get Index
        let keyRefs = Object.keys(readOnly);

        Promise.all(
          // Map all the objects to get their promises
          keyRefs.map(reference => {
            // Create promise to manage all revisions at once
            return new Promise((resolve, reject) => {
              // Get Meta data
              this.db
                .get(readOnly[reference])
                .then((read: any) => {
                  // Remove _id and _rev
                  delete read._id;
                  delete read._rev;

                  // Overwrite reference with state
                  readonlyStreams[reference] = read;
                  resolve(read);
                })
                .catch((error: Error) => {
                  // Rethrow
                  reject(error);
                });
            });
          })
        )
          .then(() => {
            // Shoudln't need to do anything as reference object has been updated
            resolve(readonlyStreams);
          })
          .catch(error => {
            // Rethrow
            reject(error);
          });
      } else {
        resolve(readonlyStreams);
      }
    });
  }

  /**
   * Validate signature for the transaction
   *
   * @private
   * @param {string} publicKey
   * @param {string} signature
   * @param {string} rsa
   * @returns {boolean}
   * @memberof Process
   */
  private signatureCheck(
    publicKey: string,
    signature: string,
    type: string = "rsa"
  ): boolean {
    try {
      // Get Key Object
      let key: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(type, publicKey);

      // Return Valid or not
      return key.verify(this.entry.$tx, signature);
    } catch (error) {
      ActiveLogger.error(error, "Signature Check Error");
      return false;
    }
  }

  /**
   * Creates a smaler trasnaction entry for ledger walking. This will also
   * keep the value deterministic (not including nodes)
   *
   * @private
   * @returns
   * @memberof Process
   */
  private compactTxEntry() {
    return {
      $umid: this.entry.$umid,
      $tx: this.entry.$tx,
      $sigs: this.entry.$sigs,
      $revs: this.entry.$revs,
      $selfsign: this.entry.$selfsign ? this.entry.$selfsign : false
    };
  }

  /**
   * Manage all errors from the Process & VM to put into the activerestore. So activerestore
   * can verify if it failed due to local coniditions or just a bad entry
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @param {Boolean} [stop]
   * @memberof Process
   */
  private raiseLedgerError(
    code: number,
    reason: Error,
    stop: Boolean = false
  ): void {
    // Store in database for activesrestore to review
    this.storeError(code, reason)
      .then(response => {
        // TODO : We need to execute postvote because this node error will prevent
        // the rest of the network from getting its chance for consensus.

        // Emit failed event for execution
        if (!stop) {
          this.emit("failed", {
            status: code,
            error: reason && reason.message ? reason.message : reason
          });
        }
      })
      .catch(error => {
        // Problem could be serious (Database down?)
        // However if this errors we need to just emit to let the ledger continue
        ActiveLogger.fatal(error, "Database Error Log Issues");

        // Emit failed event for execution
        if (!stop) {
          this.emit("failed", {
            status: code,
            error: error
          });
        }
      });
  }

  /**
   * Store Error into Database
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @returns {Promise<any>}
   * @memberof Process
   */
  private storeError(code: number, reason: Error): Promise<any> {
    // Build Document for couch
    let doc = {
      code: code,
      processed: false,
      umid: this.entry.$umid, // Easier umid lookup
      transaction: this.entry,
      reason: reason && reason.message ? reason.message : reason
    };

    // Return
    return this.dbe.post(doc);
  }
}
