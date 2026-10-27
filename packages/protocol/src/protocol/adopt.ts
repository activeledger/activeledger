/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
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

import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import {
  IAdoptDeclaration,
  IAdoptShape,
  parseAdoptType,
} from "@activeledger/activecontracts";

/**
 * Adopt mode (hybrid design, "Processing a feed item"): pure checks a
 * hybrid runs before it saves the supernodes' signed documents in place of
 * its own result.
 */

/**
 * sha256 of a stored document, as signed in a commit attestation's revsOut
 */
export const documentSha256 = (doc: unknown): string =>
  ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(doc));

/**
 * True when a fetched document is exactly the one a revsOut entry attests
 */
export const matchesRevOut = (
  doc: any,
  revOut: ActiveDefinitions.IRevOut
): boolean =>
  !!doc &&
  !!revOut &&
  doc._rev === revOut.rev &&
  documentSha256(doc) === revOut.sha256;

type TDocs = { [id: string]: any };

export interface IAdoptCheck {
  /** The transaction being adopted */
  umid: string;
  /** The signed documents, by _id, already checked against revsOut */
  signed: TDocs;
  /** This node's dry-run documents, by _id (IExecutionResult.documents) */
  local: TDocs;
  /** This node's documents at the item's $revs, by _id: the base for streams the dry run did not write */
  before?: TDocs;
  /** IExecutionResult.adopt */
  declarations: IAdoptDeclaration[];
  /** IExecutionResult.supernodeDependent */
  supernodeDependent: boolean;
}

export interface IAdoptVerdict {
  /** True: save the signed documents. False: a real divergence. */
  ok: boolean;
  /** "undeclared": adopted whole with no safety net; emit adopt.undeclared */
  mode: "verified" | "undeclared";
  reasons: string[];
}

const isPlainObject = (value: unknown): value is TDocs =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean =>
  ActiveCrypto.canonicalJson(a) === ActiveCrypto.canonicalJson(b);

/**
 * A copy without _rev: the store assigns it, and revsOut already pins it
 */
const withoutRev = (doc: TDocs): TDocs => {
  const { _rev, ...rest } = doc;
  return rest;
};

/**
 * A copy with the declared properties removed, at every depth
 */
const strip = (doc: TDocs, shape: IAdoptShape): TDocs => {
  const out: TDocs = { ...doc };
  for (const key of Object.keys(shape)) {
    const declared = shape[key];
    if (typeof declared === "string") {
      delete out[key];
    } else if (isPlainObject(out[key])) {
      out[key] = strip(out[key], declared);
    }
  }
  return out;
};

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // any
  }
};

/**
 * Every declared property in the signed document has its declared type
 */
const checkTypes = (
  doc: TDocs,
  shape: IAdoptShape,
  where: string,
  reasons: string[]
): void => {
  for (const key of Object.keys(shape)) {
    const declared = shape[key];
    const at = `${where}.${key}`;
    const present = Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;
    if (typeof declared === "string") {
      const parsed = parseAdoptType(declared);
      if (!parsed) {
        reasons.push(`${at}: unknown declared type "${declared}"`);
      } else if (!present) {
        if (!parsed.optional) reasons.push(`${at}: declared property is missing`);
      } else if (!matchesType(doc[key], parsed.type)) {
        reasons.push(`${at}: is not ${parsed.type}`);
      }
    } else if (!present) {
      reasons.push(`${at}: declared property is missing`);
    } else if (!isPlainObject(doc[key])) {
      reasons.push(`${at}: is not object`);
    } else {
      checkTypes(doc[key], declared, at, reasons);
    }
  }
};

/**
 * Paths of the declared (leaf) properties
 */
const leaves = (shape: IAdoptShape, prefix: string[] = []): string[][] => {
  const out: string[][] = [];
  for (const key of Object.keys(shape)) {
    const declared = shape[key];
    if (typeof declared === "string") out.push([...prefix, key]);
    else out.push(...leaves(declared, [...prefix, key]));
  }
  return out;
};

const at = (doc: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (isPlainObject(value) ? value[key] : undefined),
    doc
  );

/**
 * Union of several shapes for the same document
 */
const mergeShapes = (shapes: IAdoptShape[]): IAdoptShape => {
  const out: IAdoptShape = {};
  for (const shape of shapes) {
    for (const key of Object.keys(shape)) {
      const a = out[key];
      const b = shape[key];
      out[key] =
        isPlainObject(a) && isPlainObject(b)
          ? mergeShapes([a as IAdoptShape, b as IAdoptShape])
          : b;
    }
  }
  return out;
};

/**
 * The safety-net check. With no declarations, a supernode-dependent
 * execution adopts every signed document whole ("undeclared"). With
 * declarations, for each signed document:
 *
 * - it must have a local counterpart (the dry-run document, or this node's
 *   document at $revs for a stream the dry run did not write);
 * - identical to it (ignoring _rev) is always valid;
 * - otherwise its stream must be declared, by adoptFromSupernode or as a
 *   candidate of adoptStreamsFromSupernode, and:
 *   - with the declared properties removed from both, the rest is identical;
 *   - each declared property has its declared type ("?" may be absent);
 *   - atomic: the declared properties that differ are none or all;
 * - `:stream` meta and `<contractId>:data` are never declared and must be
 *   identical, except that a stream written only by the supernodes carries
 *   this transaction as its meta.umid.
 */
export const checkAdopt = (input: IAdoptCheck): IAdoptVerdict => {
  const declarations = input.declarations || [];

  if (!input.supernodeDependent) {
    return {
      ok: false,
      mode: "verified",
      reasons: ["execution was not supernode-dependent"],
    };
  }

  if (!declarations.length) {
    return { ok: true, mode: "undeclared", reasons: [] };
  }

  const reasons: string[] = [];
  const before = input.before || {};

  for (const id of Object.keys(input.signed)) {
    const signed = withoutRev(input.signed[id] || {});
    const fromLocal = input.local[id] !== undefined;
    const base = fromLocal ? input.local[id] : before[id];

    if (base === undefined || base === null) {
      reasons.push(`${id}: signed document has no local counterpart`);
      continue;
    }

    const local = withoutRev(base);

    if (id.endsWith(":stream") && !fromLocal) {
      // Untouched locally: the supernode write moved meta.umid on to us
      local.umid = input.umid;
    }

    if (same(local, signed)) continue;

    const covering = id.includes(":")
      ? []
      : declarations.filter((d) => d.streams.indexOf(id) !== -1);

    if (!covering.length) {
      reasons.push(
        id.includes(":")
          ? `${id}: differs, and it cannot be declared`
          : `${id}: differs, and the stream has no adopt declaration`
      );
      continue;
    }

    const shape = mergeShapes(covering.map((d) => d.shape));

    if (!same(strip(local, shape), strip(signed, shape))) {
      reasons.push(`${id}: differs outside the declared properties`);
    }

    checkTypes(signed, shape, id, reasons);

    for (const declaration of covering) {
      if (!declaration.atomic) continue;
      const paths = leaves(declaration.shape);
      const changed = paths.filter((p) => !same(at(local, p), at(signed, p)));
      if (changed.length && changed.length !== paths.length) {
        reasons.push(
          `${id}: atomic declaration changed ${changed.length} of ${paths.length} properties (${changed
            .map((p) => p.join("."))
            .join(", ")})`
        );
      }
    }
  }

  return { ok: !reasons.length, mode: "verified", reasons };
};
