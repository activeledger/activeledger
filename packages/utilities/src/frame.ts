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
   * Reads the first `n` bytes across the front of the chunk array without
   * concatenating everything buffered so far - almost always just
   * chunks[0] if it's already big enough, only falling back to a (small)
   * concat of the leading chunks that actually make up those n bytes.
   *
   * @private
   * @static
   * @param {Buffer[]} chunks
   * @param {number} n
   * @returns {Buffer}
   */
  private static peek(chunks: Buffer[], n: number): Buffer {
    if (chunks.length > 0 && chunks[0].length >= n) {
      return chunks[0];
    }
    let total = 0;
    let end = 0;
    while (end < chunks.length && total < n) {
      total += chunks[end].length;
      end++;
    }
    return Buffer.concat(chunks.slice(0, end));
  }

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

    const length = this.peek(chunks, 4).readUInt32BE(0);

    if (bufferLength < 4 + length) {
      // Frame not fully buffered yet - avoid paying for a full concat of
      // everything received so far just to find that out. Previously this
      // ran on every single incoming chunk of a multi-chunk message
      // (O(n^2) for an n-chunk message); now only the completed-frame case
      // below does the one full concat that's actually needed.
      return null;
    }

    const fullBuffer = Buffer.concat(chunks);
    const item = fullBuffer.slice(4, 4 + length);
    const remaining = fullBuffer.slice(4 + length);
    return {
      item,
      remaining,
      consumed: 4 + length,
    };
  }
}
