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

import { serialize, deserialize } from "v8";
import { Packr } from "msgpackr";
import { ActiveGZip } from "./gzip";

const packr = new Packr({
  useRecords: true,
  structuredClone: true,
});

export const COMPRESSION_THRESHOLD = 2048; // 2KB

export interface SerializationOptions {
  enableCompression?: boolean;
}

export const DEFAULT_SERIALIZATION_OPTIONS: SerializationOptions = {
  enableCompression: true,
};

export enum SerializationType {
  Uncompressed = 0x00,
  Gzip = 0x01
}

/**
 * High performance deep cloning using native V8 and serialization using MessagePack + optional Gzip
 *
 * @export
 * @class ActiveClone
 */
export class ActiveClone {
  /**
   * Deep clone an object using native V8 serialization (optimized for in-memory)
   *
   * @static
   * @template T
   * @param {T} obj
   * @returns {T}
   */
  public static clone<T>(obj: T): T {
    return deserialize(serialize(obj));
  }

  /**
   * Serialize an object to a buffer using MessagePack + optional Gzip
   *
   * @static
   * @template T
   * @param {T} obj
   * @param {SerializationOptions} [options=DEFAULT_SERIALIZATION_OPTIONS]
   * @returns {Promise<Buffer>}
   */
  public static async serialize<T>(
    obj: T,
    options: SerializationOptions = DEFAULT_SERIALIZATION_OPTIONS
  ): Promise<Buffer> {
    const binary = packr.pack(obj);
    
    if (options.enableCompression && binary.length > COMPRESSION_THRESHOLD) {
      const compressed = await ActiveGZip.gzip(binary);
      return Buffer.concat([Buffer.from([SerializationType.Gzip]), compressed]);
    }
    
    return Buffer.concat([Buffer.from([SerializationType.Uncompressed]), binary]);
  }

  /**
   * Deserialize a buffer back to an object (V8 -> Gzip -> MessagePack -> JSON fallback)
   *
   * @static
   * @template T
   * @param {Buffer} buffer
   * @returns {Promise<T>}
   */
  public static async deserialize<T>(buffer: Buffer): Promise<T> {
    // 1. Try V8 (Signature 0xff)
    if (buffer.length > 0 && buffer[0] === 255) {
      try {
        return deserialize(buffer);
      } catch (err) {
        throw err;
      }
    }

    // 2. Handle Binary Data (Flagged)
    if (buffer.length > 0 && (buffer[0] === SerializationType.Uncompressed || buffer[0] === SerializationType.Gzip)) {
        let data = buffer.slice(1);
        
        // Decompress if flag SerializationType.Gzip
        if (buffer[0] === SerializationType.Gzip) {
            data = await ActiveGZip.ungzip(data);
        }

        try {
            return packr.unpack(data);
        } catch {
            // Fallback to JSON
            return JSON.parse(data.toString());
        }
    }

    // 3. Fallback to JSON (for raw legacy buffers)
    return JSON.parse(buffer.toString());
  }
}
