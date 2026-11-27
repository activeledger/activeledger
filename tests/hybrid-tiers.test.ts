import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { admit, HybridTiers } from "../packages/network/src/network/hybridTiers";
import { claimSlot, FeedClient } from "../packages/network/src/network/hybridRoutes";
import { feedsStatus, listHybrids } from "../packages/network/src/network/hybridAdmin";

const h = (c: string) => c.repeat(64);

describe("Hybrid tiers", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-"));
    file = path.join(dir, "hybrid-tiers.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe("the list", () => {
    it("starts with everyone free", () => {
      const t = new HybridTiers(file);
      expect(t.rank(h("a"))).to.equal(Infinity);
      expect(t.isPremium(h("a"))).to.equal(false);
      expect(t.tierOf(h("a"))).to.equal(-1);
    });

    it("ranks by tier and then by position, best first", () => {
      const t = new HybridTiers(file);
      t.set(h("a"), 0);
      t.set(h("b"), 0);
      t.set(h("c"), 1);
      expect([t.rank(h("a")), t.rank(h("b")), t.rank(h("c"))]).to.deep.equal([0, 1, 2]);
      expect(t.tierOf(h("c"))).to.equal(1);
      expect(t.list()).to.deep.equal([[h("a"), h("b")], [h("c")]]);
    });

    it("keeps a key in one place, moving it", () => {
      const t = new HybridTiers(file);
      t.set(h("a"), 0);
      t.set(h("a"), 2);
      expect(t.list()).to.deep.equal([[], [], [h("a")]]);
      t.remove(h("a"));
      expect(t.list()).to.deep.equal([]);
      expect(t.isPremium(h("a"))).to.equal(false);
    });

    it("saves and loads, keeping only valid key hashes and the first copy of a key", () => {
      const t = new HybridTiers(file);
      t.set(h("a"), 0);
      t.set(h("b"), 1);
      expect(new HybridTiers(file).list()).to.deep.equal([[h("a")], [h("b")]]);
      fs.writeFileSync(file, JSON.stringify([[h("a"), "nope", h("a")], "x", [h("a"), h("c")]]));
      expect(new HybridTiers(file).list()).to.deep.equal([[h("a")], [h("c")]]);
    });

    it("refuses a bad key hash or tier, and starts empty from an unreadable file", () => {
      const t = new HybridTiers(file);
      expect(t.set("zz", 0)).to.equal(false);
      expect(t.set(h("a"), -1)).to.equal(false);
      expect(t.set(h("a"), 1.5)).to.equal(false);
      expect(t.remove("zz")).to.equal(false);
      fs.writeFileSync(file, "{not json");
      expect(new HybridTiers(file).list()).to.deep.equal([]);
    });

    it("unlisting a key that is not listed is fine", () => {
      expect(new HybridTiers(file).remove(h("a"))).to.equal(true);
    });
  });

  describe("the slot rule", () => {
    const tiers = new HybridTiers(path.join(os.tmpdir(), "no-such-tiers.json"));
    tiers.set(h("a"), 0);
    tiers.set(h("b"), 0);
    tiers.set(h("c"), 1);
    const feed = (c: string, connectedAt = 1) => ({ keyHash: h(c), connectedAt });

    it("lets anyone in while there is room and nothing is kept back", () => {
      expect(admit([], h("x"), 3, 0, tiers)).to.deep.equal({ ok: true });
      expect(admit([feed("y"), feed("z")], h("x"), 3, 0, tiers).ok).to.equal(true);
    });

    it("refuses a free key when full, and does not evict for it", () => {
      expect(admit([feed("y"), feed("z")], h("x"), 2, 0, tiers)).to.deep.equal({ ok: false });
    });

    it("keeps slots back from free keys", () => {
      // 3 slots, 2 kept for premium: one free feed at most
      expect(admit([], h("x"), 3, 2, tiers).ok).to.equal(true);
      expect(admit([feed("y")], h("x"), 3, 2, tiers).ok).to.equal(false);
      expect(admit([feed("y")], h("a"), 3, 2, tiers).ok).to.equal(true);
    });

    it("never keeps back more than there are slots", () => {
      expect(admit([], h("x"), 2, 50, tiers).ok).to.equal(false);
      expect(admit([], h("a"), 2, 50, tiers).ok).to.equal(true);
    });

    it("lets premium take the worst feed's place when full: the newest free one first", () => {
      const v = admit([feed("y", 1), feed("z", 9), feed("c", 5)], h("a"), 3, 0, tiers);
      expect(v).to.deep.equal({ ok: true, evict: { keyHash: h("z") } });
    });

    it("evicts a lower premium feed only when every feed is premium, never a better or equal one", () => {
      expect(admit([feed("b"), feed("c")], h("a"), 2, 0, tiers)).to.deep.equal({ ok: true, evict: { keyHash: h("c") } });
      expect(admit([feed("a"), feed("b")], h("c"), 2, 0, tiers)).to.deep.equal({ ok: false });
      expect(admit([feed("a")], h("b"), 1, 0, tiers)).to.deep.equal({ ok: false });
    });

    it("does not count the newcomer's own old feed against it", () => {
      expect(admit([feed("a")], h("a"), 1, 0, tiers)).to.deep.equal({ ok: true });
      expect(admit([feed("x")], h("x"), 1, 0, tiers)).to.deep.equal({ ok: true });
    });
  });

  describe("claiming a slot", () => {
    it("closes the feed it replaces, telling it where else to go, and leaves it out of the set", () => {
      const t = new HybridTiers(path.join(os.tmpdir(), "no-such-tiers.json"));
      t.set(h("a"), 0);
      const told: unknown[] = [];
      const free: FeedClient = { keyHash: h("y"), since: "", connectedAt: 1, end: (alts) => told.push(alts) };
      const feeds = new Set<FeedClient>([free]);
      const where = [{ host: "10.0.0.2", port: 5260 }];
      const r = claimSlot(feeds, h("a"), { maxFeeds: () => 1, tiers: t, premiumSlots: () => 0, alternatives: () => where });
      expect(r.ok).to.equal(true);
      expect(feeds.size).to.equal(0);
      expect(told).to.deep.equal([where]);
    });

    it("changes nothing for a node with no tiers set up", () => {
      const feeds = new Set<FeedClient>([{ keyHash: h("y"), since: "", connectedAt: 1 }]);
      expect(claimSlot(feeds, h("z"), { maxFeeds: () => 1 }).ok).to.equal(false);
      expect(claimSlot(feeds, h("z"), { maxFeeds: () => 2 }).ok).to.equal(true);
      expect(feeds.size).to.equal(1);
    });
  });

  describe("what the admin calls show", () => {
    it("lists the tier of each feed, best first, and of each hybrid", async () => {
      const t = new HybridTiers(path.join(os.tmpdir(), "no-such-tiers.json"));
      t.set(h("b"), 0);
      t.set(h("a"), 0);
      const feeds = new Set<FeedClient>([
        { keyHash: h("z"), since: "", connectedAt: 0 },
        { keyHash: h("a"), since: "", connectedAt: 0 },
        { keyHash: h("b"), since: "", connectedAt: 0 },
      ]);
      const s = feedsStatus(feeds, 32, 1000, t, 12);
      expect(s.premiumSlots).to.equal(12);
      expect(s.feeds.map((f) => [f.keyHash[0], f.tier])).to.deep.equal([["b", 0], ["a", 0], ["z", -1]]);
      const registry: any = { list: async () => [{ keyHash: h("a"), label: "A", endpoints: [] }, { keyHash: h("q"), label: "Q", endpoints: [] }] };
      const rows = await listHybrids(registry, feeds, new Set(), t);
      expect(rows.map((r) => r.tier)).to.deep.equal([0, -1]);
    });
  });
});
