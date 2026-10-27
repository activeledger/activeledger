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
import type { FeedClient } from "./hybridRoutes";
import type { HybridRegistry } from "./hybridApi";

/**
 * Local administration of hybrid access, for `activeledger hybrid ...`.
 * Bans are local to this supernode and are not consensus: they exist for
 * dealing with abuse under open admission.
 */
export class HybridBans {
  private hashes = new Set<string>();

  constructor(private file: string = "./hybrid-bans.json") {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) saved.forEach((h) => this.valid(h) && this.hashes.add(h));
    } catch {
      // No file yet, or unreadable: start empty
    }
  }

  private valid(hash: unknown): hash is string {
    return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  }

  public set(): Set<string> {
    return this.hashes;
  }

  public ban(hash: string): boolean {
    if (!this.valid(hash)) return false;
    this.hashes.add(hash);
    this.save();
    return true;
  }

  public unban(hash: string): boolean {
    if (!this.valid(hash)) return false;
    // Idempotent: unbanning a key that is not banned is fine
    this.hashes.delete(hash);
    this.save();
    return true;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.hashes], null, 2) + "\n");
    } catch (e) {
      ActiveLogger.error(e, "Could not save hybrid bans");
    }
  }
}

/** Admin calls come from the machine itself only */
export const isLoopback = (remoteAddress: string | undefined): boolean =>
  !!remoteAddress &&
  (remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    remoteAddress.startsWith("127."));

/** `hybrid list`: registered hybrids and whether each has a feed here */
export const listHybrids = async (
  registry: HybridRegistry,
  feeds: Set<FeedClient>,
  bans: Set<string>
) => {
  const connected = new Set([...feeds].map((f) => f.keyHash));
  return (await registry.list()).map((h) => ({
    keyHash: h.keyHash,
    label: h.label,
    endpoints: h.endpoints,
    retired: !!h.retired,
    banned: bans.has(h.keyHash),
    feedConnected: connected.has(h.keyHash),
  }));
};

/** `hybrid feeds`: connected feeds, their cursor lag, and the count against the cap */
export const feedsStatus = (
  feeds: Set<FeedClient>,
  max: number,
  now: number = Date.now()
) => ({
  count: feeds.size,
  max,
  feeds: [...feeds].map((f) => ({
    keyHash: f.keyHash,
    cursor: f.cursor ?? f.since,
    connectedSeconds: Math.round((now - f.connectedAt) / 1000),
  })),
});
