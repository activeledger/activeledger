import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Attestation } from "../packages/protocol/src/protocol/attest";
import { HybridApi, LedgerHybridRegistry, recordFailed } from "../packages/network/src/network/hybridApi";
import { feedsStatus, hybridStatus } from "../packages/network/src/network/hybridAdmin";

/**
 * Edges a mutation pass over the hybrid API found nothing checking: the
 * signed request rules, what a page boundary does to the lists the API builds
 * by paging, how long a signed attestation is kept, which failed transactions
 * are recorded, and the status view.
 */
class Mem {
  docs = new Map<string, any>();
  put(d: any) {
    this.docs.set(d._id, d);
    return this;
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d } : { notFound: true };
  }
  async exists(id: string) {
    return this.docs.has(id);
  }
  async allDocs(o: any) {
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()].sort().filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) })) };
  }
}

describe("HybridApi - edges the tests did not pin (Activenetwork)", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const pem = kp.generate().pub.pkcs8pem;
  const keyHash = ActiveCrypto.keyHash(pem);
  const RealNow = Date.now;
  afterEach(() => {
    Date.now = RealNow;
  });

  const make = (over: any = {}, lookup: any = async () => ({ key: pem, type: "rsa", endpoints: [] })) => {
    const db = new Mem();
    const events = new Mem();
    const api = new HybridApi({
      db: db as any,
      events: events as any,
      registry: { lookup, list: async () => [] },
      ledgerConfig: () => ({}),
      setupStreamId: () => "setup",
      banned: () => new Set(),
      ...over,
    });
    return { api, db, events };
  };
  const headers = (when: number) => {
    const r = ActiveCrypto.signRequest(kp, keyHash, when);
    return { key: r.key, timestamp: String(r.timestamp), signature: r.signature };
  };

  describe("signed requests", () => {
    it("need all three headers, each one", async () => {
      const { api } = make();
      const h = headers(Date.now());
      for (const missing of ["key", "timestamp", "signature"] as const) {
        const r: any = await api.authenticate({ ...h, [missing]: undefined });
        expect([missing, r.ok, r.status, r.reason]).to.deep.equal([missing, false, 401, "missing auth headers"]);
      }
    });

    it("are accepted inside the window and refused outside it, whatever width it is configured to", async () => {
      const { api } = make({ authWindowSeconds: 5 });
      expect((await api.authenticate(headers(Date.now() - 4000))).ok).to.equal(true);
      expect(((await api.authenticate(headers(Date.now() - 7000))) as any).reason).to.equal("bad signature or timestamp");
      const none = make({ authWindowSeconds: 0 }).api;
      expect(((await none.authenticate(headers(Date.now() - 3000))) as any).ok).to.equal(false);
    });

    it("work once: a replay is refused, and still is for as long as the request would be valid", async () => {
      const T = 1_800_000_000_000;
      Date.now = () => T;
      const { api } = make({ authWindowSeconds: 60 });
      // Dated 50 s ahead, which is inside the window
      const h = headers(T + 50_000);
      expect((await api.authenticate(h)).ok).to.equal(true);
      expect(((await api.authenticate(h)) as any).reason).to.equal("replayed request");
      // 61.5 s later it is still valid (11.5 s from its date) and must still be a replay
      Date.now = () => T + 61_500;
      expect(((await api.authenticate(h)) as any).reason).to.equal("replayed request");
    });

    it("keeps a feed open only for a key that is neither banned, unknown nor retired", async () => {
      const ok = make({}, async () => ({ key: pem, type: "rsa", endpoints: [] }));
      expect(await ok.api.stillAllowed(keyHash)).to.equal(true);
      expect(await make({ banned: () => new Set([keyHash]) }).api.stillAllowed(keyHash)).to.equal(false);
      expect(await make({}, async () => undefined).api.stillAllowed(keyHash)).to.equal(false);
      expect(await make({}, async () => ({ key: pem, type: "rsa", endpoints: [], retired: true })).api.stillAllowed(keyHash)).to.equal(false);
    });
  });

  describe("stream ids", () => {
    it("are 1 to 128 characters of the allowed set", () => {
      expect(HybridApi.isStreamId("")).to.equal(false);
      expect(HybridApi.isStreamId("a")).to.equal(true);
      expect(HybridApi.isStreamId("a".repeat(128))).to.equal(true);
      expect(HybridApi.isStreamId("a".repeat(129))).to.equal(false);
    });
  });

  describe("the head of the feed", () => {
    it("finds the newest key across a full page of 1000", async () => {
      const { api, events } = make();
      const now = 1_800_000_000_000;
      for (let i = 0; i <= 1000; i++) events.put({ _id: `umid:${now - 100_000 + i},u${String(i).padStart(4, "0")}` });
      expect(await api.head(now)).to.equal(`umid:${now - 100_000 + 1000},u1000`);
    });
  });

  describe("the contracts a hybrid pulls at start", () => {
    it("are found across a page boundary, each once, and only where namespace, contract and compiled are all there", async () => {
      const { api, db } = make();
      const contract = (id: string) => db.put({ _id: id, namespace: "n", contract: "c", compiled: "x" });
      for (let i = 0; i < 500; i++) db.put({ _id: `a${String(i).padStart(4, "0")}` });
      contract("a0100");
      db.put({ _id: "a0200", namespace: "n" });
      db.put({ _id: "a0201", namespace: "n", contract: "c" });
      db.put({ _id: "a0202", contract: "c", compiled: "x" });
      contract("a0499");
      contract("a0500x");
      expect((await api.bootstrap()).contracts).to.deep.equal(["a0100", "a0499", "a0500x"]);
    });
  });

  describe("a signed attestation kept for later asks", () => {
    const DATE = "2030-01-01T00:00:00.000Z";
    const MS = new Date(DATE).getTime();
    const facts = { revsOut: { s: { rev: "1-a", sha256: "h" } }, umidDocHash: "d", nodes: { a: { vote: true } } };
    const setup = (umids: string[], rowOver: any = {}) => {
      let clock = 1000;
      const signs: string[] = [];
      const m = make({
        now: () => clock,
        attest: (umid: string) => (signs.push(umid), { node: "n", umid, outcome: "committed", revsOut: {}, umidDocHash: "d", sig: "s" }),
      });
      for (const u of umids) {
        m.db.put({ _id: `${u}:umid`, umid: { $umid: u, $datetime: DATE, $revs: {} } });
        m.events.put({ _id: `umid:${MS},${u}`, ...facts, ...rowOver });
      }
      return { ...m, signs, tick: (ms: number) => (clock += ms) };
    };

    it("is made again exactly when its time is up", async () => {
      const { api, signs, tick } = setup(["u1"]);
      await api.attest("u1");
      tick(119_999);
      await api.attest("u1");
      expect(signs).to.have.length(1);
      tick(1);
      await api.attest("u1");
      expect(signs).to.have.length(2);
    });

    it("never holds more than its limit, dropping the oldest", async () => {
      const real = (HybridApi as any).SIGNED_MAX;
      (HybridApi as any).SIGNED_MAX = 2;
      try {
        const { api } = setup(["u1", "u2", "u3"]);
        for (const u of ["u1", "u2", "u3"]) await api.attest(u);
        const held = [...((api as any).signed as Map<string, any>).keys()];
        expect(held).to.deep.equal(["u2", "u3"]);
      } finally {
        (HybridApi as any).SIGNED_MAX = real;
      }
    });

    it("is not made from a row that lacks the revisions or the hash of the umid document", async () => {
      expect(await setup(["u1"], { revsOut: undefined }).api.attest("u1")).to.equal(undefined);
      expect(await setup(["u1"], { umidDocHash: undefined }).api.attest("u1")).to.equal(undefined);
    });
  });

  describe("failed transactions kept for hybrids", () => {
    const entry = (over: any = {}): any => ({
      $umid: "u1",
      $tx: { t: 1 },
      $sigs: {},
      $datetime: "2030-01-01T00:00:00.000Z",
      $revs: {},
      $nodes: { a: { vote: true, sig: "sa" }, b: { vote: false } },
      ...over,
    });
    const run = async (e: any, build = 40300, exists = false) => {
      const posted: any[] = [];
      const done = await recordFailed({ post: async (d: any) => (posted.push(d), {}) }, { exists: async () => exists }, e, build);
      return { done, posted };
    };

    it("needs build 40300, a umid and votes, each one", async () => {
      expect((await run(entry(), 40299)).done).to.equal(false);
      expect((await run(entry({ $umid: undefined }))).done).to.equal(false);
      expect((await run(entry({ $nodes: undefined }))).done).to.equal(false);
      expect((await run(entry())).done).to.equal(true);
    });

    it("keeps real votes only, with their signatures, and nothing when no node said yes", async () => {
      const r = await run(entry({ $nodes: { a: { vote: true, sig: "sa" }, b: { vote: false }, c: null, d: { vote: "yes" } } }));
      expect(r.posted[0].nodes).to.deep.equal({ a: { vote: true, sig: "sa" }, b: { vote: false } });
      expect((await run(entry({ $nodes: { a: { vote: false }, b: null } }))).done).to.equal(false);
      expect((await run(entry(), 40300, true)).done).to.equal(false);
    });

    it("records a transaction that was not self-signed as such", async () => {
      expect((await run(entry())).posted[0].tx.$selfsign).to.equal(false);
      expect((await run(entry({ $selfsign: true }))).posted[0].tx.$selfsign).to.equal(true);
    });
  });

  describe("the registry listing", () => {
    const hybrid = ActiveCrypto.hybridStreamId(pem);
    const registered = (db: Mem) => {
      db.put({ _id: hybrid, type: "default.activeledger.hybrid", key: pem });
      db.put({ _id: `${hybrid}:stream`, origin: "o1" });
      db.put({ _id: "o1:umid", umid: { $tx: { $namespace: "default", $contract: "hybrid" } } });
    };

    it("finds a registration beyond the first page of 500, and keeps the answer until its time is up", async () => {
      const db = new Mem();
      for (let i = 0; i < 500; i++) db.put({ _id: `!pad${String(i).padStart(4, "0")}` });
      registered(db);
      const T = 1_800_000_000_000;
      Date.now = () => T;
      const reg = new LedgerHybridRegistry(db as any, 1000);
      expect((await reg.list()).map((h) => h.keyHash)).to.deep.equal([keyHash]);
      db.docs.delete(hybrid);
      Date.now = () => T + 999;
      expect(await reg.list()).to.have.length(1);
      Date.now = () => T + 1000;
      expect(await reg.list()).to.have.length(0);
    });
  });
});

describe("Attestation key handling - edges the tests did not pin (Activeprotocol)", () => {
  const rsa = new ActiveCrypto.KeyPair("rsa");
  rsa.generate();
  const ed = new ActiveCrypto.KeyPair("ed25519");
  const edKeys = ed.generate();
  afterEach(() => {
    Attestation.key = undefined;
    Attestation.attestKey = undefined;
    Attestation.attestPublic = undefined;
    ActiveOptions.set("neighbourhood", undefined);
  });

  it("signs with the identity key when the Ed25519 key is held without its public half", () => {
    Attestation.key = rsa;
    Attestation.attestKey = ed;
    Attestation.attestPublic = undefined;
    ActiveOptions.set("neighbourhood", [{ attest: { type: "ed25519", public: edKeys.pub.pkcs8pem } }]);
    expect(Attestation.signer()).to.equal(rsa);
  });

  it("loads an Ed25519 key only from a file that holds both halves", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-file-"));
    const write = (attest: any) => {
      const f = path.join(dir, `id-${Math.random()}`);
      fs.writeFileSync(f, JSON.stringify({ attest }));
      return f;
    };
    try {
      Attestation.useIdentityFile(write({ prv: { pkcs8pem: edKeys.prv.pkcs8pem } }));
      expect(Attestation.attestKey).to.equal(undefined);
      Attestation.useIdentityFile(write({ pub: { pkcs8pem: edKeys.pub.pkcs8pem } }));
      expect(Attestation.attestKey).to.equal(undefined);
      Attestation.useIdentityFile(write({ prv: { pkcs8pem: edKeys.prv.pkcs8pem }, pub: { pkcs8pem: edKeys.pub.pkcs8pem } }));
      expect(Attestation.attestKey).to.not.equal(undefined);
      expect(Attestation.attestPublic).to.equal(edKeys.pub.pkcs8pem);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hybrid status and feeds view - edges the tests did not pin (Activenetwork)", () => {
  const registry: any = { list: async () => [{ retired: false }, { retired: true }, { retired: false }] };
  const feeds: any = new Set();
  const info = (section: any, over: any = {}) => ({ build: 40300, requiredBuild: 40300, section, signing: "off" as const, attestKeyHeld: false, ...over });
  const status = (section: any, over: any = {}) => hybridStatus(registry, feeds, 32, info(section, over));

  it("is enabled only for an object section", async () => {
    expect((await status({ admission: "open" })).enabled).to.equal(true);
    expect((await status({})).enabled).to.equal(true);
    for (const not of [undefined, null, [], "open"]) expect((await status(not)).enabled, String(not)).to.equal(false);
  });

  it("has a build that is enough exactly at the required one", async () => {
    expect((await status(undefined, { build: 40299 })).buildOk).to.equal(false);
    expect((await status(undefined, { build: 40300 })).buildOk).to.equal(true);
  });

  it("describes the admission rule, and counts the allowlist, only when enabled", async () => {
    expect((await status({ admission: "open" })).admission).to.equal("open");
    const list = await status({ admission: { allowlist: ["a", "b"] } });
    expect([list.admission, list.allowed]).to.deep.equal(["allowlist", 2]);
    const empty = await status({ admission: {} });
    expect(empty.allowed).to.equal(0);
    const none = await status({});
    expect([none.admission, none.allowed]).to.deep.equal([undefined, undefined]);
    const off = await status(undefined);
    expect([off.admission, off.allowed, off.minVersion]).to.deep.equal([undefined, undefined, undefined]);
    expect((await status({ minVersion: "5.1.0" })).minVersion).to.equal("5.1.0");
  });

  it("counts registered and retired hybrids apart", async () => {
    const s = await status({});
    expect([s.registered, s.retired]).to.deep.equal([2, 1]);
  });

  it("shows a feed's own cursor, even an empty one, before where it asked to start", () => {
    const f: any = new Set([{ keyHash: "k", cursor: "", since: "x", connectedAt: 0 }]);
    expect(feedsStatus(f, 32, 1000).feeds[0].cursor).to.equal("");
  });
});
