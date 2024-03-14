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
import { ActiveLogger } from "@activeledger/activecontracts";

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
   * @memberof PermissionsChecker
   */
  private inputs: boolean;

  /**
   * The inputs or outputs to be processed
   *
   * @private
   * @type {*}
   * @memberof PermissionsChecker
   */
  private data: string[];

  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private db: ActiveDSConnect,
    private checkRevs: boolean,
    private securityCache: ISecurityCache,
    private shared: Shared
  ) { }

  /**
   * Entry point for processing stream data
   *
   * @param {*} data
   * @param {boolean} [inputs=true]
   * @returns {Promise<ActiveDefinitions.LedgerStream[]>}
   * @memberof PermissionsChecker
   */
  public async process(
    data: string[],
    inputs: boolean = true
  ): Promise<ActiveDefinitions.LedgerStream[]> {
    this.inputs = inputs;
    this.data = data;

    // NOTE: Using ActiveLogger here will cause Activeledger to fail to start

    try {
      // Get all streams to process from the database
      const streams: ActiveDefinitions.LedgerStream[] = await this.buildPromises();

      return this.processStreams(streams);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Build an array of promises that are used to generate and check streams
   *
   * @private
   * @returns {Promise<any>[]}
   * @memberof PermissionsChecker
   */
  private async buildPromises(): Promise<ActiveDefinitions.LedgerStream[]> {
    // Map into a single alldocs lookup
    const keys: string[] = [];
    let contractDataIncluded = false;

    for (let i = this.data.length; i--;) {
      // Skip the map as the map is also to support labels. Here we just need raw id's
      const filteredPrefix = this.shared.filterPrefix(this.data[i], true);

      // Are we looking at contract data?
      const suffix = this.data[i].split(":")[1];
      contractDataIncluded = suffix === "data";

      // Maybe use set instead of checking?
      if(keys.indexOf(filteredPrefix) === -1) {
        keys.push(filteredPrefix + ":stream");
        keys.push(filteredPrefix);
      }
    }

    // Single fetch
    try {
      const docs = await this.db.allDocs({
        keys,
        include_docs: true,
      });

      // The docs wont be ordered as the keys said they would be need to create a reorder
      const reorder: {
        [index: string]: number;
      } = {};
      const results: ActiveDefinitions.LedgerStream[] = [];

      // Must be a better way to manage this, Less operations
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

      // If contract data is being dealt with we need to handle meta ourselves
      if (contractDataIncluded) {

        for (let i = results.length; i--;) {
          const sId = results[i].state._id;

          if (sId && sId.indexOf(":data")) {
            let cRes = results[i];
            cRes.meta = {
              _id: `${cRes.state._id}:meta`,
              _rev: "0-context"
            }

            results[i] = cRes;
          }
        }
      }

      // lengths should match then have all streams and meta data
      if (results.length === (keys.length / 2)) {
        return results;
      } else {
        throw {
          code: 950,
          reason: "Stream(s) not found",
        };
      }
    } catch (error) {
      // Add Info
      error.code = 950;
      error.reason = "Stream(s) not found";
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
   * @memberof PermissionsChecker
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
          if (revType[streamId] !== currentRevision) {
            return reject({
              code: 1200,
              reason:
                (this.inputs ? "Input" : "Output") +
                " Stream Position Incorrect",
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
   * @memberof PermissionsChecker
   */
  private signatureCheck(
    streamId: string,
    stream: ActiveDefinitions.LedgerStream,
    nhpkCheck: boolean,
    nhpkCheckIO: ActiveDefinitions.LedgerIORputs,
    reject: (value?: any) => void
  ): void {
    const sigCheck = (authority: ActiveDefinitions.ILedgerAuthority): boolean =>
      this.shared.signatureCheck(
        authority.public,
        this.entry.$sigs[this.shared.filterPrefix(streamId)] as string,
        authority.type
      );

    const isLedgerAuthSignatures = ActiveDefinitions.LedgerTypeChecks.isLedgerAuthSignatures(
      this.entry.$sigs[this.shared.filterPrefix(streamId)]
    );

    if (isLedgerAuthSignatures) {
      // Multiple signatures passed
      // Check that they haven't sent more signatures than we have authorities

      const sigStreamKeys = Object.keys(this.entry.$sigs[this.shared.filterPrefix(streamId)]);
      const authorities = stream.meta.authorities.length;
      if (sigStreamKeys.length > authorities) {
        return reject({
          code: 1225,
          reason:
            (this.inputs ? "Input" : "Output") +
            " Incorrect Signature List Length",
        });
      }

      // Loop over signatures
      // Every supplied signature should exist and pass
      const sigCheck = sigStreamKeys.every((sigStream: string) => {
        if (nhpkCheck) {
          const nhpk = false;
          /* let nhpk, nhpkIO; // Undefined if other data not found

          // Build up with checks to prevenr undefined errors
          const ioLabelMap = this.shared.getLabelIOMap(this.inputs, streamId);

          if (ioLabelMap) nhpkIO = nhpkCheckIO[ioLabelMap];

          if (nhpkIO) nhpk = nhpkIO.$nhpk[sigStream]; */

          if (!nhpk) {
            return reject({
              code: 1230,
              reason:
                (this.inputs ? "Input" : "Output") +
                " Security Hardened Key Transactions Only",
            });
          }
        } else {
          // Get signature from tx object
          const signature = (this.entry.$sigs[
            this.shared.filterPrefix(streamId)
          ] as ActiveDefinitions.LedgerAuthSignatures)[sigStream];
          const authCheck = stream.meta.authorities.some(
            (authority: ActiveDefinitions.ILedgerAuthority) => {
              // If matching hash do sig check
              if (authority.hash === sigStream) {
                return this.shared.signatureCheck(
                  authority.public,
                  signature,
                  authority.type
                );
              } else {
                return false;
              }
            }
          );

          return authCheck;
        }
      });

      if (!sigCheck) {
      }
    } else {
      const authorityCheck = stream.meta.authorities.some(
        (authority: ActiveDefinitions.ILedgerAuthority) => {
          const nhpk =
            nhpkCheckIO[this.shared.getLabelIOMap(this.inputs, streamId)].$nhpk;

          // Check if this authority has new keys
          if (nhpkCheck && !nhpk) {
            return reject({
              code: 1230,
              reason:
                (this.inputs ? "Input" : "Output") +
                " Security Hardened Key Transactions Only",
            });
          }

          if (authority.hash && sigCheck(authority)) {
            // Remap $sigs for later consumption

            this.entry.$sigs[this.shared.filterPrefix(streamId)] = {
              [authority.hash]: this.entry.$sigs[this.shared.filterPrefix(streamId)] as string,
            };
            return true;
          } else {
            return false;
          }
        }
      );

      if (!authorityCheck) {
        // Break loop and reject
        return reject({
          code: 1220,
          reason: (this.inputs ? "Input" : "Output") + " Signature Incorrect",
        });
      }
    }
  }
}
