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

import * as fs from "fs";

/**
 * One approved nano client. `identity` is the stream id nano onboarded on
 * this same ledger (the same value it signs attestation transactions
 * with) - no separate key-distribution step needed, since the actual
 * public key material is looked up live from that identity's own
 * `:stream` meta doc (`meta.authorities[].public`) at auth time. `label`
 * is operator-facing only.
 */
export interface IAllowlistEntry {
  identity: string;
  label?: string;
  addedAt?: number;
}

/**
 * File-backed, hand-managed allowlist - "we need to make it so 'allowed'
 * nanos can connect" (the user's own framing). No on-chain governance
 * yet, deliberately - an operator approves a nano by adding its identity
 * to this file and reloading. Reload happens per-request (cheap - a small
 * JSON file, and correctness of "did the operator just revoke this nano"
 * matters more here than shaving a filesystem read).
 */
export class Allowlist {
  constructor(private filePath: string) {}

  public isApproved(identity: string): boolean {
    return this.load().some((entry) => entry.identity === identity);
  }

  public list(): IAllowlistEntry[] {
    return this.load();
  }

  public add(entry: IAllowlistEntry): void {
    const current = this.load();
    if (current.some((e) => e.identity === entry.identity)) return;
    current.push({ ...entry, addedAt: entry.addedAt ?? Date.now() });
    fs.writeFileSync(this.filePath, JSON.stringify(current, null, 2) + "\n");
  }

  public remove(identity: string): void {
    const current = this.load().filter((e) => e.identity !== identity);
    fs.writeFileSync(this.filePath, JSON.stringify(current, null, 2) + "\n");
  }

  private load(): IAllowlistEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as IAllowlistEntry[];
    } catch {
      return [];
    }
  }
}
