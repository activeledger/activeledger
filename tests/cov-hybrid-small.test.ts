import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { ContractBuilder } from "../packages/hybrid/src/contracts";
import { ItemOrderer } from "../packages/hybrid/src/orderer";
import { writeDivergence } from "../packages/hybrid/src/divergence";
import { resolveModulesDir } from "../packages/hybrid/src/workspace";

/** A document store that holds what it is given and answers what it holds */
const fakeData = () => {
  const docs = new Map<string, any>();
  return {
    docs,
    get: async (id: string) => {
      if (!docs.has(id)) throw new Error("missing");
      return docs.get(id);
    },
    bulkDocs: async (list: any[]) => {
      for (const d of list) docs.set(d._id, d);
      return { ok: true };
    },
  };
};

describe("Hybrid divergence write (cov)", () => {
  const record: any = { umid: "u1", at: "2026-01-01T00:00:00.000Z", kind: "state" };
  it("returns the key it wrote under", async () => {
    const posted: any[] = [];
    const key = await writeDivergence({ events: { post: async (d: any) => (posted.push(d), { ok: true, id: d._id }) } } as any, record);
    expect(key).to.equal(`divergence:${String(Date.parse(record.at)).padStart(13, "0")},u1`);
    expect(posted[0]._id).to.equal(key);
    expect(posted[0].kind).to.equal("state");
  });
  it("throws when the store reports an error without confirming", async () => {
    for (const answer of [{ error: "bad" }, { reason: "disk" }]) {
      let err: any;
      try {
        await writeDivergence({ events: { post: async () => answer } } as any, record);
      } catch (e) {
        err = e;
      }
      expect(err.message).to.contain("not written").and.to.contain(answer.reason || answer.error);
    }
  });
  it("accepts an answer that carries an error but also confirms the write", async () => {
    await writeDivergence({ events: { post: async () => ({ ok: true, error: "meh" }) } } as any, record);
    await writeDivergence({ events: { post: async () => ({ id: "x", reason: "meh" }) } } as any, record);
  });
});

describe("Hybrid workspace (cov)", () => {
  it("refuses a package it cannot find, saying which", () => {
    expect(() => resolveModulesDir("@nobody/no-such-package-here")).to.throw(/Could not find a node_modules containing @nobody\/no-such-package-here/);
  });
  it("finds the real modules directory for a package that is installed", () => {
    const dir = resolveModulesDir("mocha");
    expect(fs.existsSync(path.join(dir, "mocha"))).to.equal(true);
  });
});

describe("Hybrid ItemOrderer (cov)", () => {
  it("turns a processor that throws into a dropped item, never an unhandled rejection", async () => {
    const orderer = new ItemOrderer({
      processor: { apply: async () => { throw new Error("kaboom"); } } as any,
      store: { data: fakeData() } as any,
    });
    const item: any = { umid: "u1", outcome: "committed", $revs: {} };
    const o = await orderer.submit(item, {} as any);
    expect(o.action).to.equal("dropped");
    expect(o.vote).to.equal("no");
    expect(o.umid).to.equal("u1");
    expect(o.reasons).to.deep.equal(["apply failed: kaboom"]);
    expect(orderer.pending).to.equal(0);
  });
  it("reports a thrown non-error as its text", async () => {
    const orderer = new ItemOrderer({
      processor: { apply: async () => { throw "plain"; } } as any,
      store: { data: fakeData() } as any,
    });
    const o = await orderer.submit({ umid: "u2", outcome: "x" } as any, {} as any);
    expect(o.reasons).to.deep.equal(["apply failed: plain"]);
  });
});

describe("Hybrid ContractBuilder failure paths (cov)", () => {
  let tmp: string;
  let warns: string[];
  const origWarn = (ActiveLogger as any).warn;
  const ts = (msg: string) => Buffer.from(`export default "${msg}" as string;`).toString("base64");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-contracts-"));
    warns = [];
    (ActiveLogger as any).warn = (m: string) => warns.push(String(m));
  });
  afterEach(() => {
    (ActiveLogger as any).warn = origWarn;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const make = (data: any, sources: any, verify?: any) =>
    new ContractBuilder({ store: { data }, sources, verify, rootDir: tmp + "/" });

  it("fetches a umid from the first source that has it, skipping one that throws or answers wrongly", async () => {
    const good = { umid: { $umid: "U" } };
    const calls: string[] = [];
    const sources = {
      supernodes: [
        { umid: async () => { calls.push("a"); throw new Error("down"); } },
        { umid: async () => { calls.push("b"); return { umid: { $umid: "OTHER" } }; } },
      ],
      peers: [{ umid: async () => { calls.push("c"); return good; } }],
    };
    const b: any = make(fakeData(), sources);
    expect(await b.fetchUmid("U")).to.equal(good);
    expect(calls).to.deep.equal(["a", "b", "c"]);
  });
  it("prefers the umid it already holds", async () => {
    const data = fakeData();
    data.docs.set("U:umid", { _id: "U:umid", mine: true });
    const b: any = make(data, { supernodes: [{ umid: async () => { throw new Error("asked"); } }], peers: [] });
    expect((await b.fetchUmid("U")).mine).to.equal(true);
  });
  it("gives up with undefined when nobody has the umid", async () => {
    const b: any = make(fakeData(), { supernodes: [], peers: [{ umid: async () => undefined }] });
    expect(await b.fetchUmid("U")).to.equal(undefined);
  });

  const contractState = (extra: any = {}) => ({
    _id: "c1",
    _rev: "1-a",
    namespace: "ns",
    compiled: true,
    contract: { "1.0.0": ts("one") },
    ...extra,
  });

  it("builds a verified contract and remembers it", async () => {
    const data = fakeData();
    data.docs.set("c1:stream", { _id: "c1:stream", _rev: "1-b" });
    const b = make(data, { supernodes: [], peers: [] }, async () => true);
    const r = await b.rebuild(contractState());
    expect(r).to.deep.equal({ built: ["1.0.0"], failed: [] });
    expect(fs.readFileSync(`${tmp}/ns/c1@1.0.0.js`, "utf8")).to.contain("one");
    // the same revision is not built twice
    fs.rmSync(`${tmp}/ns`, { recursive: true });
    expect(await b.rebuild(contractState())).to.deep.equal({ built: [], failed: [] });
    expect(fs.existsSync(`${tmp}/ns`)).to.equal(false);
  });
  it("reports a version it cannot build, builds the others, and tries again next time", async () => {
    const data = fakeData();
    data.docs.set("c1:stream", { _id: "c1:stream", _rev: "1-b" });
    const b = make(data, { supernodes: [], peers: [] }, async () => true);
    const state = contractState({ contract: { "1.0.0": { hash: "h" }, "2.0.0": ts("two") } });
    const r = await b.rebuild(state);
    expect(r.built).to.deep.equal(["2.0.0"]);
    expect(r.failed.length).to.equal(1);
    expect(r.failed[0].version).to.equal("1.0.0");
    expect(r.failed[0].reason).to.be.a("string").and.not.equal("");
    expect(warns.some((w) => w.includes("Cannot build contract c1@1.0.0"))).to.equal(true);
    // not cached as built: a second call tries again
    const again = await b.rebuild(state);
    expect(again.failed.length).to.equal(1);
  });
  it("refuses to build what it cannot verify", async () => {
    const b = make(fakeData(), { supernodes: [], peers: [] });
    const r = await b.rebuild(contractState());
    expect(r.built).to.deep.equal([]);
    expect(r.failed).to.deep.equal([{ version: "*", reason: "contract stream is not verified" }]);
    expect(fs.existsSync(`${tmp}/ns`)).to.equal(false);
  });

  describe("fetchVerified", () => {
    const meta = { _id: "c1:stream", _rev: "1-m" };
    it("is not fetched without a verifier", async () => {
      const b: any = make(fakeData(), { supernodes: [{ id: "s", streams: async () => { throw new Error("asked"); } }], peers: [] });
      expect(await b.fetchVerified("c1")).to.equal(undefined);
      expect(warns.some((w) => w.includes("no verifier"))).to.equal(true);
    });
    it("skips a supernode that throws and uses one that verifies", async () => {
      const data = fakeData();
      const state = contractState();
      const sources = {
        supernodes: [
          { id: "bad", streams: async () => { throw new Error("offline"); } },
          { id: "good", streams: async () => ({ docs: [state, meta], missing: [] }) },
        ],
        peers: [],
      };
      const b: any = make(data, sources, async () => true);
      expect(await b.fetchVerified("c1")).to.equal(state);
      expect(warns.some((w) => w.includes("Contract c1: bad: offline"))).to.equal(true);
      expect(data.docs.get("c1")).to.equal(state);
      expect(data.docs.get("c1:stream")).to.equal(meta);
    });
    it("takes the highest revision that verifies, and ignores one that does not", async () => {
      const data = fakeData();
      const low = contractState({ _rev: "1-a" });
      const high = contractState({ _rev: "3-c" });
      const forged = contractState({ _rev: "9-z" });
      const serve = (s: any) => ({ id: "n", streams: async () => ({ docs: [s, meta], missing: [] }) });
      const b: any = make(data, { supernodes: [serve(low), serve(forged), serve(high)], peers: [] }, async (s: any) => s._rev !== "9-z");
      expect((await b.fetchVerified("c1"))._rev).to.equal("3-c");
      expect(data.docs.get("c1")._rev).to.equal("3-c");
    });
    it("fetches nothing when no supernode serves both the state and its meta", async () => {
      const data = fakeData();
      const b: any = make(data, { supernodes: [{ id: "n", streams: async () => ({ docs: [contractState()], missing: [] }) }], peers: [] }, async () => true);
      expect(await b.fetchVerified("c1")).to.equal(undefined);
      expect(data.docs.size).to.equal(0);
    });
    it("fetches nothing when the write is not confirmed", async () => {
      const data: any = fakeData();
      data.bulkDocs = async () => ({});
      const b: any = make(data, { supernodes: [{ id: "n", streams: async () => ({ docs: [contractState(), meta], missing: [] }) }], peers: [] }, async () => true);
      expect(await b.fetchVerified("c1")).to.equal(undefined);
    });
  });
});
