/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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

import { ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ISecurityCache } from "./interfaces/process.interface";
import { Shared } from "./shared";
import { ActiveLogger } from "@activeledger/activelogger";

/**
 * Manages the permissions of revisions and signatures of each stream type
 *
 * @export
 * @class PermissionsChecker
 */
export class PermissionsChecker {
  /**
   * Input flag, true if we are processing inputs
   *
   * @private
   * @type {boolean}
   */
  private inputs: boolean;

  /**
   * The inputs or outputs to be processed
   *
   * @private
   * @type {*}
   */
  private data: string[];

  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private db: ActiveDSConnect,
    //private checkRevs: boolean,
    private securityCache: ISecurityCache,
    private shared: Shared
  ) { }

  /**
   * Entry point for processing stream data
   *
   * @param {*} data
   * @param {boolean} [inputs=true]
   * @returns {Promise<ActiveDefinitions.LedgerStream[]>}
   */
  public async process(
    data: string[],
    inputs: boolean = true,
    retry: number = 0
  ): Promise<ActiveDefinitions.LedgerStream[]> {
    this.inputs = inputs;
    this.data = data;
    try {
      // Get all streams to process from the database
      const streams: ActiveDefinitions.LedgerStream[] =
        await this.buildPromises();

      return this.processStreams(streams);
    } catch (error) {
      // Quorum change safety mech. 60% instant new transaction needing 100%
      // TODO make this variable based on entry node or not.
      const allowedRetries = 6;
      const waitTime = 250;
      if (retry >= allowedRetries) {
        ActiveLogger.info(
          this.data,
          `Error Fetching Streams after ${allowedRetries} retries, giving up`
        );
        return Promise.reject(error);
      } else {
        ActiveLogger.info(
          this.data,
          `Error Fetching Streams retry ${retry} of ${allowedRetries} with ${waitTime}ms wait - ${this.entry.$umid}`
        );
        // Small delay should help write finalise but we don't want
        // wait to long as it holds the transaction up from failing its vote
        await this.sleep(waitTime);
        ActiveLogger.info(error, `Retrying PermissionsChecker due to - ${this.entry.$umid}`);
        return await this.process(data, inputs, ++retry);
      }
    }
  }

  /**
   * Basic awaitable sleep
   *
   * TODO : Reduce duplicated code found in ./process.ts
   *
   * @private
   * @param {number} time
   * @returns
   */
  private sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  /**
   * Build an array of promises that are used to generate and check streams
   *
   * @private
   * @returns {Promise<any>[]}
   */
  private async buildPromises(): Promise<ActiveDefinitions.LedgerStream[]> {
    const keys = new Set<string>();
    let contractDataIncluded = false;

    for (const streamId of this.data) {
      const filteredPrefix = this.shared.filterPrefix(streamId, true);
      const suffix = streamId.split(":")[1];
      contractDataIncluded = suffix === "data";

      if (suffix !== "data") {
        keys.add(filteredPrefix + ":stream");
      }

      if (!this.shared.sigOnly[filteredPrefix]) {
        keys.add(filteredPrefix);
      }
    }

    const keyArray = Array.from(keys);
    // Single fetch
    try {
      // The docs wont be ordered as the keys said they would be need to create a reorder
      const reorder: {
        [index: string]: number;
      } = {};
      const results: ActiveDefinitions.LedgerStream[] = [];

      if (keyArray.length) {
        const docs = await this.db.allDocs({
          keys: keyArray,
          include_docs: true,
        });

        // Must be a better way to manage this, Less operations
        if (docs?.rows) {
          for (let i = docs.rows.length; i--;) {
            // stream will be last so most likely need to replace
            // Using .doc for consistancy between data engines
            const baseDoc = docs.rows[i].doc._id.replace(":stream", "");
            let iMeta: ActiveDefinitions.IMeta | null = null;
            let iState: ActiveDefinitions.IFullState | null = null;
            if (baseDoc === docs.rows[i].doc._id) {
              // state
              iState = docs.rows[i].doc as ActiveDefinitions.IFullState;
            } else {
              // Check meta
              // Check script lock
              iMeta = docs.rows[i].doc as ActiveDefinitions.IMeta;

              if (
                iMeta.contractlock &&
                iMeta.contractlock.length &&
                iMeta.contractlock.indexOf(this.entry.$tx.$contract) === -1
              ) {
                // We have a lock but not for the current contract request
                throw {
                  code: 1700,
                  reason: "Stream contract locked",
                };
              }

              // Check namspace lock
              if (
                iMeta.namespaceLock &&
                iMeta.namespaceLock.length &&
                iMeta.namespaceLock.indexOf(this.entry.$tx.$namespace) === -1
              ) {
                // We have a lock but not for the current contract request
                throw {
                  code: 1710,
                  reason: "Stream namespace locked",
                };
              }
            }

            // Manage the reorder object
            if (!reorder[baseDoc]) {
              reorder[baseDoc] = results.push({
                state: iState as any,
                meta: iMeta as any,
              });
            } else {
              // Update missing
              const result = results[reorder[baseDoc] - 1];
              if (result.state) {
                if (iMeta) result.meta = iMeta;
              } else {
                if (iState) result.state = iState;
              }
            }
          }
        }
      }

      // If contract data is being dealt with we need to handle meta ourselves
      if (contractDataIncluded) {
        for (let i = results.length; i--;) {
          const sId = results[i].state._id;

          if (sId && sId.indexOf(":data")) {
            let cRes = results[i];
            cRes.meta = {
              _id: `${cRes.state._id}:meta`,
              _rev: "0-context",
            };

            results[i] = cRes;

            // Lets bump keys to include the fake meta
            // This means the same 950 check works for all opts
            keyArray.push(`${cRes.state._id}:meta`);
          }
        }
      }

      const sigOnlyAdjustment = this.data.filter(id => this.shared.sigOnly[this.shared.filterPrefix(id, true)]).length;
      // lengths should match then have all streams and meta data
      // wonder why it added contractdataincluded! (and it doesn't stop the tx? )
      //if (results.length * 2 === (keyArray.length - (contractDataIncluded ? 1 : 0) + sigOnlyAdjustment)) {
      if (results.length * 2 === (keyArray.length + sigOnlyAdjustment)) {
        return results;
      } else {
        throw {
          code: 950,
          reason: "Stream(s) not found",
        };
      }
    } catch (error) {
      ActiveLogger.error(error, "Error fetching streams for permissions check - " + this.entry.$umid);
      // Preserve a deliberately-thrown, specific error (1700/1710 from the
      // lock checks above, or this function's own 950 "not found") -
      // only default to the generic "Stream(s) not found" for a genuinely
      // unexpected failure (e.g. the allDocs() call itself throwing) that
      // doesn't already carry a real error code. Previously this
      // overwrote unconditionally, so a contractlock/namespaceLock
      // rejection always surfaced to the client as a misleading 950
      // "Stream(s) not found" instead of the documented 1700/1710 -
      // found while adding network-test coverage for locked streams.
      if (!error.code) {
        error.code = 950;
        error.reason = "Stream(s) not found";
      }
      // Rethrow
      throw error;
    }
  }

  /**
   * Process the passed streams
   *
   * @private
   * @param {ActiveDefinitions.LedgerStream[]} stream
   * @returns {Promise<ActiveDefinitions.LedgerStream[]>}
   */
  private processStreams(
    stream: ActiveDefinitions.LedgerStream[]
  ): Promise<ActiveDefinitions.LedgerStream[]> {
    return new Promise((resolve, reject) => {
      let i = stream.length;
      while (i--) {
        // Quick Reference
        let streamId: string = stream[i].state._id as string;

        // Get revision type
        const revType = this.inputs ? this.entry.$revs.$i : this.entry.$revs.$o;
        // Build comparison ID from metadata
        const currentRevision =
          stream[i].meta._rev + ":" + stream[i].state._rev;

        // Check that the revisions match between nodes
        if (revType && revType[streamId]) {
          // Don't really need to compare stream data if sigOnly signature itself verifies it (maybe throw warning)
          // reason sig verifies if I mod 1 node to different pubkey the others don't mind they will false it as sig wont match
          if ((revType[streamId] !== currentRevision) && !this.shared.sigOnly[this.shared.filterPrefix(streamId)]) { //prefix maybe here?
            // Normal and meta
            // this.db.clearCache(streamId);
            // this.db.clearCache(`${streamId}:stream`);

            return reject({
              code: 1200,
              reason:
                (this.inputs ? "Input" : "Output") +
                ` Stream Position Incorrect (${revType[streamId]} !== ${currentRevision} - Local)`,
            });
          }
        } else {
          revType[streamId] = currentRevision;
        }

        // Signature Check & Hardened Keys (Inputs and maybe Outputs based on configuration)
        if (this.inputs || this.securityCache.signedOutputs) {
          // Authorities need to be checked flag
          let nhpkCheck = false;

          // Label of Key support
          let nhpkCheckIO = this.inputs ? this.entry.$tx.$i : this.entry.$tx.$o;

          // Check to see if key hardening is enabled and done
          if (this.securityCache.hardenedKeys) {
            // Maybe specific authority of the stream now, $nhpk could be string or object of strings
            // Need to map over because it may not be stream id!

            const nhpkDataCheck =
              nhpkCheckIO[this.shared.getLabelIOMap(this.inputs, streamId)]
                .$nhpk;

            if (!nhpkDataCheck) {
              return reject({
                code: 1230,
                reason:
                  (this.inputs ? "Inputs" : "Output") +
                  " Security Hardened Key Transactions Only",
              });
            } else {
              nhpkCheck = true;
            }
          }

          // Check signature
          if (stream[i].meta.authorities) {
            /*
             * Some will return true early, at this stage we only need 1.
             * The Smart contract developer can use the other signatures
             * to create a mini consensus within their own application (such as ownership)
             */

            this.signatureCheck(
              streamId,
              stream[i],
              nhpkCheck,
              nhpkCheckIO,
              reject
            );
          } else {
            // Backwards compatible check
            const type = stream[i].meta.type ? stream[i].meta.type : "rsa";
            const sigCheck = this.shared.signatureCheck(
              stream[i].meta.public as string,
              this.entry.$sigs[this.shared.filterPrefix(streamId)] as string,
              type
            );

            if (!sigCheck) {
              // Break loop and reject
              return reject({
                code: 1220,
                reason:
                  (this.inputs ? "Input" : "Output") + " Signature Incorrect",
              });
            }
          }

          // If sig only dont need the data anymore (can also not fetch main state)
          if (this.shared.sigOnly[streamId]) {
            // Splice this loop iteration to remove from the data returned
            stream.splice(i, 1);
          }

        }
      }

      // Everything is good
      resolve(stream);
    });
  }

  /**
   * Check the signature of a stream
   *
   * @private
   * @param {string} streamId
   * @param {ActiveDefinitions.LedgerStream} stream
   * @param {boolean} nhpkCheck
   * @param {ActiveDefinitions.LedgerIORputs} nhpkCheckIO
   * @param {(value?: any) => void} reject
   * @returns {void}
   */
  private signatureCheck(streamId: string, stream: ActiveDefinitions.LedgerStream, nhpkCheck: boolean, nhpkCheckIO: ActiveDefinitions.LedgerIORputs, reject: (value?: any) => void): void {
    const sigCheck = (authority: ActiveDefinitions.ILedgerAuthority): boolean =>
      this.shared.signatureCheck(
        authority.public,
        this.entry.$sigs[this.shared.filterPrefix(streamId)] as string,
        authority.type
      );

    const signatureContainer = this.entry.$sigs[this.shared.filterPrefix(streamId)];

    if (ActiveDefinitions.LedgerTypeChecks.isLedgerAuthSignatures(signatureContainer)) {
      this.checkMultiSignature(streamId, stream, signatureContainer, nhpkCheck, reject);
    } else {
      this.checkSingleSignature(streamId, stream, signatureContainer, nhpkCheck, nhpkCheckIO, reject);
    }
  }

  private checkMultiSignature(streamId: string, stream: ActiveDefinitions.LedgerStream, signatureContainer: ActiveDefinitions.LedgerAuthSignatures, nhpkCheck: boolean, reject: (value?: any) => void): void {
    const sigStreamKeys = Object.keys(signatureContainer);
    if (sigStreamKeys.length > stream.meta.authorities.length) {
      return reject({
        code: 1225,
        reason: `${this.inputs ? "Input" : "Output"} Incorrect Signature List Length`,
      });
    }

    const allSignaturesValid = sigStreamKeys.every((sigStream: string) => {
      if (nhpkCheck) {
        // Hardened key logic seems incomplete, for now returning false to match original behaviour
        // This should probably throw the 1230 error.
        return false;
      }

      const signature = signatureContainer[sigStream];
      return stream.meta.authorities.some(
        (authority: ActiveDefinitions.ILedgerAuthority) =>
          authority.hash === sigStream && this.shared.signatureCheck(authority.public, signature, authority.type)
      );
    });

    if (!allSignaturesValid) {
      return reject({
        code: 1220,
        reason: `${this.inputs ? "Input" : "Output"} Signature Incorrect`,
      });
    }
  }

  private checkSingleSignature(streamId: string, stream: ActiveDefinitions.LedgerStream, signature: string, nhpkCheck: boolean, nhpkCheckIO: ActiveDefinitions.LedgerIORputs, reject: (value?: any) => void): void {
    const authorityCheck = stream.meta.authorities.some(
      (authority: ActiveDefinitions.ILedgerAuthority) => {
        if (nhpkCheck) {
          const nhpk = nhpkCheckIO[this.shared.getLabelIOMap(this.inputs, streamId)].$nhpk;
          if (!nhpk) {
            reject({
              code: 1230,
              reason: `${this.inputs ? "Input" : "Output"} Security Hardened Key Transactions Only`,
            });
            return false; // Stop iteration
          }
        }

        if (this.shared.signatureCheck(authority.public, signature, authority.type)) {
          // Remap $sigs for later consumption if it was a simple signature
          if (authority.hash) {
            this.entry.$sigs[this.shared.filterPrefix(streamId)] = {
              [authority.hash]: signature,
            };
          }
          return true;
        }
        return false;
      }
    );

    if (!authorityCheck) {
      reject({
        code: 1220,
        reason: `${this.inputs ? "Input" : "Output"} Signature Incorrect`,
      });
    }
  }
}
