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

/**
 * Adopt declarations: what a contract says its supernode-only branch writes,
 * so a hybrid can accept the supernodes' signed outputs for exactly those
 * properties and nothing else (see the hybrid design, "Contract API").
 */

export type TAdoptType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "any";

/**
 * Property name to type. A `?` suffix ("string?") marks the property
 * optional. A nested object describes nested properties.
 */
export interface IAdoptShape {
  [property: string]: string | IAdoptShape;
}

export interface IAdoptOptions {
  /** The declared properties that differ must be none or all of them */
  atomic?: boolean;
}

export interface IAdoptDeclaration {
  /** The activity's own id, or the candidate list of adoptStreamsFromSupernode */
  streams: string[];
  shape: IAdoptShape;
  atomic: boolean;
  /** Made with adoptStreamsFromSupernode: a listed stream may also come back unchanged */
  candidates: boolean;
}

const ADOPT_TYPES: TAdoptType[] = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "any",
];

/**
 * Parse a type string such as "string?". Null when it is not a known type.
 */
export const parseAdoptType = (
  value: string
): { type: TAdoptType; optional: boolean } | null => {
  const optional = value.endsWith("?");
  const type = (optional ? value.slice(0, -1) : value) as TAdoptType;
  return ADOPT_TYPES.indexOf(type) === -1 ? null : { type, optional };
};

const isPlainObject = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Throws when the shape is not a valid adopt description. `_id` and `_rev`
 * can never be declared: they identify the document, not its content.
 */
export const validateAdoptShape = (shape: unknown, path: string = ""): void => {
  const where = path || "shape";
  if (!isPlainObject(shape)) {
    throw new Error(`Invalid adopt shape: ${where} must be an object`);
  }
  const keys = Object.keys(shape);
  if (!keys.length) {
    throw new Error(`Invalid adopt shape: ${where} declares no properties`);
  }
  for (const key of keys) {
    const at = path ? `${path}.${key}` : key;
    if (!path && (key === "_id" || key === "_rev")) {
      throw new Error(`Invalid adopt shape: ${at} cannot be declared`);
    }
    const value = shape[key];
    if (typeof value === "string") {
      if (!parseAdoptType(value)) {
        throw new Error(`Invalid adopt shape: ${at} has unknown type "${value}"`);
      }
    } else {
      validateAdoptShape(value, at);
    }
  }
};
