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
  ) {}

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

    try {
      const promiseHolder = this.buildPromises();

      // Get all streams to process from the database
      const streams: ActiveDefinitions.LedgerStream[] = await Promise.all(
        promiseHolder
      );

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
  private buildPromises(): Promise<any>[] {
    const holder: Promise<any>[] = [];

    this.data.map((id: any) => {
      const promise = new Promise(async (resolve, reject) => {
        try {
          const docs = await this.db.allDocs({
            keys: [id + ":stream", id],
            include_docs: true
          });
          if (docs.rows.length === 2) {
            // Get Documents (Swapped around with new engine)
            const [state, meta]: any = docs.rows as string[];

            // Check meta
            // Check script lock
            let iMeta: ActiveDefinitions.IMeta = meta.doc as ActiveDefinitions.IMeta;

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

            // Check namspace lock
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

            // Resolve the whole stream
            resolve({
              meta: meta.doc,
              state: state.doc
            });
          } else {
            reject({ code: 995, reason: "Stream(s) not found" });
          }
        } catch (error) {
          // Add Info
          error.code = 990;
          error.reason = "Stream(s) not found";
          // Rethrow
          reject(error);
        }
      });

      holder.push(promise);
    });

    return holder;
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
                " Stream Position Incorrect"
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
                  " Security Hardened Key Transactions Only"
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
              this.entry.$sigs[streamId] as string,
              type
            );

            if (!sigCheck) {
              // Break loop and reject
              return reject({
                code: 1220,
                reason:
                  (this.inputs ? "Input" : "Output") + " Signature Incorrect"
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
        this.entry.$sigs[streamId] as string,
        authority.type
      );

    const isLedgerAuthSignatures = ActiveDefinitions.LedgerTypeChecks.isLedgerAuthSignatures(
      this.entry.$sigs[streamId]
    );

    if (isLedgerAuthSignatures) {
      // Multiple signatures passed
      // Check that they haven't sent more signatures than we have authorities

      const sigStreamKeys = Object.keys(this.entry.$sigs[streamId]);
      const authorities = stream.meta.authorities.length;
      if (sigStreamKeys.length > authorities) {
        return reject({
          code: 1225,
          reason:
            (this.inputs ? "Input" : "Output") +
            " Incorrect Signature List Length"
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
                " Security Hardened Key Transactions Only"
            });
          }
        } else {
          // Get signature from tx object
          const signature = (this.entry.$sigs[
            streamId
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
                " Security Hardened Key Transactions Only"
            });
          }

          if (authority.hash && sigCheck(authority)) {
            // Remap $sigs for later consumption

            this.entry.$sigs[streamId] = {
              [authority.hash]: this.entry.$sigs[streamId] as string
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
          reason: (this.inputs ? "Input" : "Output") + " Signature Incorrect"
        });
      }
    }
  }
}
