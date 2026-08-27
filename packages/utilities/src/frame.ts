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

/**
 * P2P Frame Utility
 *
 * @export
 * @class ActiveFrame
 */
export class ActiveFrame {
  /**
   * Reads a frame from the chunk array
   *
   * @static
   * @param {Buffer[]} chunks
   * @param {number} bufferLength
   * @returns {{ item: Buffer; remaining: Buffer; consumed: number } | null}
   */
  public static read(chunks: Buffer[], bufferLength: number): { item: Buffer; remaining: Buffer; consumed: number } | null {
    if (bufferLength < 4) return null;

    const fullBuffer = Buffer.concat(chunks);
    const length = fullBuffer.readUInt32BE(0);

    if (bufferLength >= 4 + length) {
      const item = fullBuffer.slice(4, 4 + length);
      const remaining = fullBuffer.slice(4 + length);
      return {
        item,
        remaining,
        consumed: 4 + length,
      };
    }
    return null;
  }
}
