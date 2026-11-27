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
import { ActiveLogger } from "@activeledger/activelogger";

/**
 * Which hybrids this supernode serves first. A list of tiers, best first, each
 * a list of key hashes in priority order; a key that is not listed is free.
 * Local to one supernode and not consensus, like the ban list.
 */
export class HybridTiers {
  private tiers: string[][] = [];

  constructor(private file: string = "./hybrid-tiers.json") {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) {
        const seen = new Set<string>();
        for (const tier of saved) {
          if (!Array.isArray(tier)) continue;
          // A key sits in one place only: the first one wins
          const keep: string[] = [];
          for (const h of tier) {
            if (this.valid(h) && !seen.has(h)) {
              seen.add(h);
              keep.push(h);
            }
          }
          this.tiers.push(keep);
        }
      }
    } catch {
      // No file yet, or unreadable: everyone is free
    }
  }

  private valid(hash: unknown): hash is string {
    return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  }

  /** Where a key stands, lower is better. A key that is not listed is free: Infinity. */
  public rank(hash: string): number {
    let before = 0;
    for (const tier of this.tiers) {
      const at = tier.indexOf(hash);
      if (at >= 0) return before + at;
      before += tier.length;
    }
    return Infinity;
  }

  /** The tier a key is in, 0 the best, or -1 for free */
  public tierOf(hash: string): number {
    return this.tiers.findIndex((t) => t.includes(hash));
  }

  public isPremium(hash: string): boolean {
    return this.tierOf(hash) >= 0;
  }

  public list(): string[][] {
    return this.tiers.map((t) => [...t]);
  }

  /** Put a key in a tier (0 is the best), at the end of it, moving it if it was elsewhere */
  public set(hash: string, tier: number = 0): boolean {
    if (!this.valid(hash) || !Number.isInteger(tier) || tier < 0 || tier > 9) return false;
    this.remove(hash, false);
    while (this.tiers.length <= tier) this.tiers.push([]);
    this.tiers[tier].push(hash);
    this.save();
    return true;
  }

  /** Back to free. Idempotent. */
  public remove(hash: string, save: boolean = true): boolean {
    if (!this.valid(hash)) return false;
    this.tiers = this.tiers.map((t) => t.filter((h) => h !== hash));
    while (this.tiers.length && !this.tiers[this.tiers.length - 1].length) this.tiers.pop();
    if (save) this.save();
    return true;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.tiers, null, 2) + "\n");
    } catch (e) {
      ActiveLogger.error(e, "Could not save hybrid tiers");
    }
  }
}

/** What a feed asks for, and what the slot rule answers */
export interface Admission {
  ok: boolean;
  /** The feed to close to make room, when there is one */
  evict?: { keyHash: string };
}

/**
 * The slot rule. Premium feeds may use any of the `max` slots. Free feeds may
 * use only `max - premiumSlots`, so the rest stay open for premium. When it is
 * full, a premium feed takes the place of the worst feed below it: a free feed
 * first, newest first; then a premium feed ranked lower than itself.
 */
export const admit = (
  feeds: Iterable<{ keyHash: string; connectedAt: number }>,
  newcomer: string,
  max: number,
  premiumSlots: number,
  tiers: Pick<HybridTiers, "rank" | "isPremium">
): Admission => {
  const others = [...feeds].filter((f) => f.keyHash !== newcomer);
  const reserved = Math.max(0, Math.min(premiumSlots, max));
  const freeMax = max - reserved;

  if (!tiers.isPremium(newcomer)) {
    const free = others.filter((f) => !tiers.isPremium(f.keyHash)).length;
    return { ok: others.length < max && free < freeMax };
  }

  if (others.length < max) return { ok: true };

  const mine = tiers.rank(newcomer);
  // The worst feed first (highest rank, then newest), if it is below the newcomer
  const worst = [...others].sort((a, b) => {
    const r = tiers.rank(b.keyHash) - tiers.rank(a.keyHash);
    if (r !== 0 && !Number.isNaN(r)) return r;
    return b.connectedAt - a.connectedAt;
  })[0];
  if (worst && tiers.rank(worst.keyHash) > mine) return { ok: true, evict: { keyHash: worst.keyHash } };
  return { ok: false };
};
