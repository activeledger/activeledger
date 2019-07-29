import { ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { rejects } from "assert";
import { ISecurityCache } from "./interfaces/process.interface";
import { Shared } from "./shared";
import { LedgerStream, LedgerIORputs } from "../../../definitions/src/definitions/ledger";

export class PermissionsChecker {
  constructor(
    private data: any,
    private entry: ActiveDefinitions.LedgerEntry,
    private db: ActiveDSConnect,
    private checkRevs: boolean,
    private inputs: boolean = false,
    private securityCache: ISecurityCache,
    private shared: Shared
  ) {}

  public async process(): Promise<any> {
    try {
      const promiseHolder = this.buildPromises();

      // Get all streams to process from the database
      const streams: ActiveDefinitions.LedgerStream[] = await Promise.all(
        promiseHolder
      );

      return this.processStreams(streams);
    } catch (error) {
      rejects(error);
    }
  }

  private buildPromises(): Promise<any>[] {
    const holder: Promise<any>[] = [];

    this.data.map((id: any) => {
      const promise = new Promise(async (resolve, reject) => {
        try {
          const docs = await this.db.allDocs({
            keys: [id + ":stream", id],
            include_docs: true
          });

          if (docs.rows.length === 3) {
            // Get Documents
            const [meta, state]: any = docs.rows as string[];

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

  private processStreams(
    stream: ActiveDefinitions.LedgerStream[]
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let i = stream.length;
      while (i--) {
        // Quick Reference
        let streamId: string = stream[i].state._id as string;

        // Get revision type
        const revType = this.inputs ? this.entry.$revs.$i : this.entry.$revs.$o;
        // Build comparison ID from metadata
        const metadataId = stream[i].meta._rev + ":" + stream[i].state._rev;

        const checkSetResponse = this.checkOrSetRevisions(
          streamId,
          revType,
          metadataId
        );
        if (checkSetResponse) {
          reject(checkSetResponse);
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

            this.signatureCheck(streamId, stream[i], nhpkCheck, nhpkCheckIO, reject);

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

  private checkOrSetRevisions(
    streamId: string,
    revType: ActiveDefinitions.LedgerRevIO,
    metadataId: string
  ): { code: number; reason: string } | null {
    if (this.checkRevs) {
      if (revType[streamId] !== metadataId) {
        return {
          code: 1200,
          reason:
            (this.inputs ? "Input" : "Output") + " Stream Position Incorrect"
        };
      } else {
        revType[streamId] = metadataId;
        return null;
      }
    } else {
      return null;
    }
  }

  private signatureCheck(
    streamId: string, 
    stream: ActiveDefinitions.LedgerStream, 
    nhpkCheck: boolean, 
    nhpkCheckIO: ActiveDefinitions.LedgerIORputs,
    reject: (value?: any) => void
  ): void {
    const sigCheck = (authority: ActiveDefinitions.ILedgerAuthority): boolean => this.shared.signatureCheck(
      authority.public,
      this.entry.$sigs[streamId] as string,
      authority.type
    );

    const isLedgerAuthSignatures = ActiveDefinitions.LedgerTypeChecks.isLedgerAuthSignatures(this.entry.$sigs[streamId]);

    if (isLedgerAuthSignatures) {
      // Multiple signatures passed
      // Check that they haven't sent more signatures than we have authorities

      const sigStreamKeys = Object.keys(this.entry.$sigs[streamId]);
      const authorities = stream.meta.authorities.length;
      if (sigStreamKeys.length > authorities) {
        return reject({
          code: 1225,
          reason: (this.inputs ? "Input" : "Output") + " Incorrect Signature List Length";
        });
      }

      // Loop over signatures
      // Every supplied signature should exist and pass
      const sigCheck = sigStreamKeys.every((sigStream: string) => {

        const nhpk = nhpkCheckIO[this.shared.getLabelIOMap(this.inputs, streamId)].$nhpk[sigStream];

        if (nhpkCheck && !nhpk) {
          return reject({
            code: 1230,
            reason: (this.inputs ? "Input" : "Output") + " Security Hardened Key Transactions Only"
          });
        } else {
          // Get signature from tx object
          const signature = (this.entry.$sigs[streamId] as ActiveDefinitions.LedgerAuthSignatures)[sigStream];
          const authCheck = stream.meta.authorities.some(
            (authority: ActiveDefinitions.ILedgerAuthority) => {
              // If matching hash do sig check
              if (authority.hash === sigStream) {
                return this.shared.signatureCheck(authority.public, signature, authority.type);
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
          const nhpk = nhpkCheckIO[this.shared.getLabelIOMap(this.inputs, streamId)].$nhpk;

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
          reason:
            (this.inputs ? "Input" : "Output") + " Signature Incorrect"
        });
      } 
    }
  }
}
