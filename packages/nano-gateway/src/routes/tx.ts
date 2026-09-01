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

import { ActiveDSConnect } from "@activeledger/activeoptions";
import { IActiveHttpIncoming } from "@activeledger/httpd";

/**
 * Transaction-by-umid lookup, off the `{umid}:umid` doc streamUpdater.ts
 * writes on commit (packages/protocol/src/protocol/streamUpdater.ts's
 * compactTxEntry()). Deliberately NOT a port of Activecore's findUmid()
 * (packages/core/src/controllers/umid.ts) - that returns `{umid: <compact
 * tx entry>}`, confusingly naming the field after the lookup key rather
 * than what it actually holds. New code doesn't get to inherit that either.
 */
export async function getTransaction(incoming: IActiveHttpIncoming, db: ActiveDSConnect): Promise<unknown> {
  try {
    const doc = await db.get(`${incoming.url[2]}:umid`);
    return { transaction: doc.umid ?? null };
  } catch {
    return { transaction: null };
  }
}
