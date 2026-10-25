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

import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { openEmbeddedStorage } from "@activeledger/activestorage";
import { IHybridConfig } from "@activeledger/activedefinitions/lib/definitions";
import { HybridServer } from "./api";
import { BootstrapError, bootstrapNode, isOutdated, requiredIds, resumeCursor, saveCursor } from "./bootstrap";
import { EventLog } from "./events";
import { FeedManager, cursorKey } from "./feed";
import { HttpUpstream, HybridIdentity, loadIdentity } from "./http-upstream";
import { SourceLookup } from "./lookup";
import { ItemOrderer } from "./orderer";
import { P2PUpstream } from "./p2p-upstream";
import { Processor } from "./processor";
import { listDivergences } from "./divergence";
import { Pruner } from "./pruner";
import { Submitter } from "./submit";
import { HybridStore, NodeState, Sources } from "./types";
import { Upstream } from "./upstream";
import { prepareWorkspace } from "./workspace";

/** The start-up steps, in order. The start-up display and the state file name these. */
export const NODE_STEPS = ["config", "identity", "store", "bootstrap", "catching up", "ready"];
export type NodeStep = (typeof NODE_STEPS)[number];

export interface HybridNodeOptions {
  config: IHybridConfig;
  /** Data directory: one database per directory inside it */
  dataDir: string;
  identityPath: string;
  /** This hybrid's release */
  version: string;
  /** Progress, for the start-up display and the state file */
  onStep?: (step: NodeStep, event: "begin" | "done" | "fail", detail?: string) => void;
  /** Catching-up progress: seconds behind and the cursor */
  onProgress?: (lagSeconds: number, cursor: string) => void;
  /** Build the client for an endpoint; replaced in tests */
  makeUpstream?: (
    endpoint: ActiveDefinitions.IHybridEndpoint,
    identity: HybridIdentity,
    network: () => string
  ) => Upstream;
  /** Lag at which "catching up" counts as done. Default: the head is confirmed. */
  maxStartLagSeconds?: number;
  /** Set false in tests that never execute contracts, so no directories appear in the working directory */
  prepareWorkspace?: boolean;
  /** Poll for catch-up progress at this interval. Default 250ms. */
  progressMs?: number;
}

const ms = (cursor: string) => Number(cursorKey(cursor).split(",")[0]) || 0;

/**
 * One hybrid node: opens its store, serves its API, bootstraps from an
 * upstream, then follows the ledger until stopped.
 */
export class HybridNode {
  public readonly state: NodeState;
  private store?: HybridStore & { close(): Promise<void> };
  private server?: HybridServer;
  private address?: { port: number };
  private feed?: FeedManager;
  private pruner?: Pruner;
  private setupDoc: any;
  private networkId = "";
  private volatile = new Set<string>();
  private headSeen = "";
  private startedOutdated = false;

  constructor(private readonly options: HybridNodeOptions) {
    this.state = {
      version: options.version,
      ready: false,
      reason: "starting",
      cursor: "",
      headConfirmedAt: 0,
      upstreams: options.config.upstreams.map((u) => ({ host: `${u.host}:${u.port}`, ok: false })),
    };
  }

  private step<T>(name: NodeStep, work: () => Promise<T>): Promise<T> {
    this.options.onStep?.(name, "begin");
    return work().then(
      (value) => {
        this.options.onStep?.(name, "done");
        return value;
      },
      (e) => {
        this.options.onStep?.(name, "fail", (e as Error).message);
        throw e;
      }
    );
  }

  /** The port the API listens on (useful when the config asks for 0) */
  public get port(): number | undefined {
    return this.address?.port;
  }

  public async start(): Promise<void> {
    const { config } = this.options;

    await this.step("config", async () => undefined);
    const identity = await this.step("identity", async () => loadIdentity(this.options.identityPath));

    const store = await this.step("store", async () => {
      const opened = await openEmbeddedStorage(path.resolve(this.options.dataDir));
      return opened as unknown as HybridStore & { close(): Promise<void> };
    });
    this.store = store;
    // Process runs contracts from ./contracts and ./default_contracts
    if (this.options.prepareWorkspace !== false) prepareWorkspace();

    const make =
      this.options.makeUpstream ??
      ((e, id, network) =>
        e.transport === "p2p"
          ? new P2PUpstream({ host: e.host, port: e.port, identity: id, network })
          : new HttpUpstream({ host: e.host, port: e.port, identity: id, tls: e.tls }));
    const network = () => this.networkId;
    const sources: Sources = {
      supernodes: config.upstreams.map((u) => make(u, identity, network)),
      peers: config.peers.map((p) => make(p, identity, network)),
    };

    const lookup = new SourceLookup({ store, sources: () => sources });
    const events = new EventLog(store.events);
    const volatileHeld = (id: string) => this.volatile.has(id);
    const processor = new Processor({
      store,
      sources: () => sources,
      lookup,
      events,
      context: () => this.state.verify,
      setup: () => this.setupDoc,
      volatileHeld,
    });
    const orderer = new ItemOrderer({ processor, store });
    const submitter = new Submitter({
      config,
      state: this.state,
      sources,
      lookup,
      identity: { pair: identity.pair, publicPem: identity.publicPem },
      db: store.data as any,
      dryRun: (entry) =>
        ActiveProtocol.Process.dryRunHybrid(entry, store.data as any, { volatileHeld }),
    });

    this.pruner = new Pruner({ store, config, publicPem: identity.publicPem });

    // Serve /health from the start: it answers 503 "starting" until ready
    this.server = new HybridServer({
      config,
      state: this.state,
      store,
      lookup,
      submitter,
      sources,
      admin: {
        divergences: async (since) =>
          listDivergences(store, since === undefined ? undefined : isNaN(Number(since)) ? new Date(since) : Number(since)),
        prune: async (dryRun) => {
          if (!this.pruner) throw new Error("not started");
          return this.pruner.run({ dryRun });
        },
      },
    });
    this.address = await this.server.start();

    const boot = await this.step("bootstrap", async () => {
      const result = await bootstrapNode({
        upstreams: sources.supernodes,
        pin: config.pin,
        version: this.options.version,
        store,
        lookup,
        contracts: processor.contractBuilder as NonNullable<typeof processor.contractBuilder>,
      });
      this.setupDoc = result.setup;
      this.networkId = result.network;
      this.state.verify = result.verify;
      this.state.minVersion = result.minVersion;
      this.volatile = new Set(
        (result.bootstrap.required ?? [])
          .filter((r: any) => typeof r !== "string" && r?.volatile)
          .map((r: any) => r.id)
      );
      if (result.outdated) {
        this.state.reason = "outdated";
        this.startedOutdated = true;
      }
      return result;
    });

    // A quorum of attestations needs more than the one supernode this node
    // follows. The setup stream names every supernode, and a registered key is
    // accepted by all of them. They are asked for attestations and umid
    // documents only: both are checked against signatures and hashes whoever
    // serves them. They never serve stream content, tips or the feed, and the
    // plain-http connection to them is therefore not what the trust rests on.
    const known = new Set(sources.supernodes.map((u) => u.id));
    const followed = [boot.upstream, ...sources.supernodes.filter((u) => u !== boot.upstream)];
    for (const n of boot.setup.neighbourhood ?? []) {
      if (typeof n?.host !== "string" || !Number.isInteger(Number(n?.port))) continue;
      const extra = make({ host: n.host, port: Number(n.port), transport: "http" }, identity, network);
      if (known.has(extra.id)) continue;
      known.add(extra.id);
      (sources.attesters ??= []).push(extra);
    }

    const cursor = await resumeCursor(store, boot.bootstrap.cursor);
    this.state.cursor = cursor;
    // First in the list is the one that answered the bootstrap
    const order = followed;
    this.feed = new FeedManager({
      upstreams: order,
      state: this.state,
      apply: (item, from) => orderer.submit(item, from),
      saveCursor: (c) => saveCursor(store, c),
      onMinVersion: (v) => this.minVersionSeen(v),
      onOutcome: (o) => {
        const line = `${o.umid.slice(0, 12)} ${o.action} (${o.vote})${o.reasons.length ? ": " + o.reasons.join("; ") : ""}`;
        // Anything but a clean save is worth reading; the rest is background
        o.action === "saved" || o.action === "settled" ? ActiveLogger.debug(line) : ActiveLogger.warn(line);
        for (const w of o.warnings) ActiveLogger.warn(`${o.umid.slice(0, 12)} ${w}`);
      },
    });

    if (!boot.outdated) {
      await this.step("catching up", () => this.catchUp(cursor, boot.bootstrap.cursor));
    } else {
      // Nothing to catch up on: an outdated node applies nothing. It stays up
      // so /health says why, and resumes from its cursor once upgraded.
      this.feed.start(cursor);
      ActiveLogger.warn(
        `This release (${this.options.version}) is below the network minimum (${boot.minVersion}); not applying items`
      );
    }

    this.pruner.start();

    await this.step("ready", async () => {
      if (!boot.outdated) {
        this.state.ready = true;
        this.state.reason = undefined;
      }
    });
  }

  /**
   * A heartbeat named a `minVersion`. A raised one that leaves this release
   * below it stops the node applying items, as at start-up. One lowered
   * again lets it resume, unless it was outdated from the start and so never
   * pulled the streams it needs, which takes a restart.
   */
  private minVersionSeen(minVersion: string): void {
    if (minVersion === this.state.minVersion || !/^\d+\.\d+\.\d+/.test(minVersion)) return;
    this.state.minVersion = minVersion;
    const outdated = isOutdated(this.options.version, minVersion);
    if (outdated && this.state.reason !== "outdated") {
      this.state.reason = "outdated";
      this.state.ready = false;
      ActiveLogger.warn(
        `This release (${this.options.version}) is below the network minimum (${minVersion}); not applying items`
      );
    } else if (!outdated && this.state.reason === "outdated") {
      if (this.startedOutdated) {
        ActiveLogger.warn(`The network minimum is now ${minVersion}; restart to resume`);
        return;
      }
      this.state.reason = undefined;
      this.state.ready = true;
      ActiveLogger.info(`The network minimum is now ${minVersion}; applying items again`);
    }
  }

  /** Follow the feed until the head is confirmed (or the allowed lag is reached) */
  private async catchUp(cursor: string, bootstrapHead: string): Promise<void> {
    this.headSeen = bootstrapHead;
    this.feed!.start(cursor);
    const every = this.options.progressMs ?? 250;
    const allowed = this.options.maxStartLagSeconds;
    for (;;) {
      const head = this.feed!.head || this.headSeen;
      const lag = Math.max(0, (ms(head) - ms(this.state.cursor)) / 1000);
      this.options.onProgress?.(lag, this.state.cursor);
      if (this.state.headConfirmedAt > 0 || (allowed !== undefined && lag <= allowed && this.state.cursor)) return;
      await new Promise((r) => setTimeout(r, every));
    }
  }

  public async stop(): Promise<void> {
    this.pruner?.stop();
    await this.feed?.stop();
    await this.server?.stop();
    await this.store?.close();
    this.state.ready = false;
  }
}

export { BootstrapError, requiredIds };
