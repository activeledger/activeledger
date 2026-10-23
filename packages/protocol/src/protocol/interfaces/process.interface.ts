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

import { IAdoptDeclaration } from "@activeledger/activecontracts";

interface ISecurityNamespaceData {
  std: string[];
  external: string[];
  mock: string[];
}

interface ISecurityNamespaces {
  [namespace: string]: ISecurityNamespaceData;
}

export interface ISecurityCache {
  namespace: ISecurityNamespaces;
  signedOutputs: boolean;
  hardenedKeys: boolean;
}

export interface IReferenceStreams {
  new: any[];
  updated: any[];
}

export type TProcessMode = "supernode" | "hybrid";

export interface IProcessOptions {
  /**
   * "supernode" (default) is the voting node, unchanged. "hybrid" is one
   * local node: no vote broadcast, no ring knocks, contracts see
   * isSupernode() false and run in the egress sandbox, and nothing is
   * written - run it with dryRun().
   */
  mode?: TProcessMode;
  /** Hybrid: true when this node holds the stream's (shared) volatile */
  volatileHeld?: (streamId: string) => boolean;
}

export interface IDryRunOptions extends Omit<IProcessOptions, "mode"> {
  /** This node's reference in $nodes. Default "hybrid". */
  reference?: string;
  /** host:port the contract sees as selfHost. Default "hybrid". */
  selfHost?: string;
  /** Run this exact contract version file (as Process.start) */
  contractVersion?: string;
}

/**
 * Outcome of a dry run: what this node would have voted and written
 */
export interface IExecutionResult {
  umid: string;
  /** This node's vote: verify and vote passed */
  vote: boolean;
  /** The commit phase ran and built its documents without error */
  committed: boolean;
  /** Why it did not, when it did not */
  error?: string;
  /** Documents the commit would write, by _id: state, `:stream` meta and `<contractId>:data` */
  documents: { [id: string]: any };
  /** `:volatile` documents the commit would write (per node, never attested) */
  volatile: { [id: string]: any };
  /** The `:umid` document the commit would write */
  umidDoc?: any;
  /** Data returned to the client */
  return?: unknown;
  /** Events the contract raised (none were written) */
  events: any[];
  /** isSupernode() called, egress blocked, unheld volatile read, or inter-node comms used */
  supernodeDependent: boolean;
  /** The reasons, e.g. "isSupernode", "blocked:https", "volatile:<streamId>" */
  dependence: string[];
  /** adoptFromSupernode / adoptStreamsFromSupernode declarations */
  adopt: IAdoptDeclaration[];
}
