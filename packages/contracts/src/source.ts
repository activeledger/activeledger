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
import * as ts from "typescript-api";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";

export type ContractTarget = "es2017" | "es2025";

/**
 * Raised when a version's source cannot be recovered: a hash-only legacy
 * entry, a missing umid document, or a document whose source does not match
 * the hash recorded against the version.
 */
export class ContractSourceError extends Error {}

/**
 * Where a contract version's TypeScript came from, verified
 */
export interface ResolvedContract {
  /** The base64 TypeScript, as deployed */
  base64: string;
  hash: string;
  target: ContractTarget;
}

/**
 * Fetches a `<umid>:umid` document, or undefined when it is not held
 */
export type UmidFetcher = (umid: string) => Promise<any | undefined>;

export class ContractSource {
  /**
   * Hash a contract's source for storage against its version.
   *
   * Hashes the DECODED source bytes, deliberately. The base64 envelope is
   * not canonical (padding and line breaks vary with whoever encoded it),
   * and the transpiled output depends on the TypeScript version the node
   * ships - hashing either would let two honest nodes disagree about the
   * same deploy.
   */
  public static hash(base64: string): string {
    return ActiveCrypto.Hash.getHash(
      Buffer.from(base64, "base64").toString(),
      "sha256"
    );
  }

  /**
   * Transpile base64 TypeScript to JavaScript.
   *
   * The editions are pinned, never ScriptTarget.Latest - a compiler upgrade
   * must not move the target of a contract under anyone.
   */
  public static transpile(
    base64: string,
    target: ContractTarget = "es2017"
  ): string {
    return ts.transpileModule(Buffer.from(base64, "base64").toString(), {
      compilerOptions: {
        alwaysStrict: true,
        strictNullChecks: true,
        noImplicitAny: true,
        removeComments: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Classic,
        target:
          target === "es2025"
            ? ts.ScriptTarget.ES2025
            : ts.ScriptTarget.ES2017,
        // TypeScript 6 defaults esModuleInterop on, which rewrites `import *`
        // and default imports in contract code. Off, the es2017 output is
        // byte-identical to 5.6.3 across every .ts in this repo; a contract
        // must not change behaviour because the node that compiles it was
        // upgraded.
        esModuleInterop: false,
        ignoreDeprecations: "6.0",
      },
    }).outputText;
  }

  /**
   * Recover one version's source from a contract stream's state.
   *
   * - A legacy entry is the base64 inline.
   * - A reference is read back out of the deploying transaction's umid
   *   document (`$tx.$i[state.identity].contract`) and checked against the
   *   recorded hash, so a node can prove what it recovered is what was
   *   deployed.
   */
  public static async resolve(
    state: { contract: { [version: string]: ActiveDefinitions.TContractEntry }; identity?: string },
    version: string,
    fetchUmid: UmidFetcher
  ): Promise<ResolvedContract> {
    const entry = state.contract?.[version];
    if (entry === undefined) {
      throw new ContractSourceError(`No version ${version}`);
    }

    if (typeof entry === "string") {
      return { base64: entry, hash: ContractSource.hash(entry), target: "es2017" };
    }

    if (!ActiveDefinitions.isContractRef(entry)) {
      throw new ContractSourceError(`Malformed entry for version ${version}`);
    }
    if (!entry.umid) {
      throw new ContractSourceError(
        `Version ${version} has a hash but no umid to recover it from`
      );
    }
    if (!state.identity) {
      throw new ContractSourceError(
        `Contract state has no identity naming which $i held the source`
      );
    }

    const doc = await fetchUmid(entry.umid);
    const base64 = doc?.umid?.$tx?.$i?.[state.identity]?.contract;
    if (typeof base64 !== "string") {
      throw new ContractSourceError(
        `Deploy transaction ${entry.umid} is not held or holds no source`
      );
    }
    if (ContractSource.hash(base64) !== entry.hash) {
      throw new ContractSourceError(
        `Source in ${entry.umid} does not match the hash for version ${version}`
      );
    }
    return { base64, hash: entry.hash, target: entry.target ?? "es2017" };
  }
}

/**
 * The compiled contract files a node runs: `<ns>/<name>.js` as latest,
 * `<ns>/<name>@<version>.js` per version, and `_LOCK.` files.
 */
export class ContractFiles {
  /** Root directory with its trailing separator, e.g. "./contracts/" */
  constructor(private rootDir: string) {
    if (!rootDir.endsWith("/")) this.rootDir += "/";
  }

  private dir(namespace: string): string {
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
    const dir = this.rootDir + namespace;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Write the code as latest and as the given version */
  public write(namespace: string, name: string, version: string, code: string): void {
    const dir = this.dir(namespace);
    fs.writeFileSync(`${dir}/${name}.js`, code);
    fs.writeFileSync(`${dir}/${name}@${version}.js`, code);
  }

  /** Path of a lock file; `version` includes its leading "@", or is "" */
  public lockPath(namespace: string, contract: string, version = ""): string {
    return `${this.rootDir}${namespace}/_LOCK.${contract}${version}`;
  }

  public isLocked(namespace: string, contract: string, version = ""): boolean {
    return fs.existsSync(this.lockPath(namespace, contract, version));
  }

  public lock(namespace: string, contract: string, version = ""): void {
    fs.closeSync(fs.openSync(this.lockPath(namespace, contract, version), "w"));
  }

  public unlock(namespace: string, contract: string, version = ""): void {
    fs.unlinkSync(this.lockPath(namespace, contract, version));
  }

  public exists(namespace: string, name: string): boolean {
    return fs.existsSync(`${this.rootDir}${namespace}/${name}.js`);
  }
}
