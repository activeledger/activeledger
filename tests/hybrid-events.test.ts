import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import {
  EventFilter,
  EventLog,
  FilterError,
  isOwnEvent,
  pinnedFilter,
} from "../packages/hybrid/src/events";

// The stored shapes: a contract event as the VM's EventEngine writes it, and
// the hybrid's own events as EventLog writes them
const contractEvent = (contract: string, data: any, name = "transfer") => ({
  name,
  data,
  phase: "commit",
  contract,
});
const own = (name: string, contract?: string, data: any = {}) => ({
  name,
  data,
  phase: "hybrid",
  ...(contract ? { contract } : {}),
});

describe("Hybrid events: EventFilter", () => {
  const q = (s: string) => EventFilter.parseQuery(new URLSearchParams(s));
  const allows = (pinned: any, client: string, event: any) =>
    new EventFilter(pinnedFilter({ events: pinned }), q(client)).allows(event);

  describe("no pinned filter", () => {
    it("serves everything to a client without a filter", () => {
      expect(allows(undefined, "", contractEvent("a", { t: "x" }))).to.equal(true);
      expect(allows(undefined, "", own("tx.committed", "a"))).to.equal(true);
      expect(allows(undefined, "", own("divergence"))).to.equal(true);
    });

    it("?contract= is repeatable and matches any listed", () => {
      expect(allows(undefined, "contract=a&contract=b", contractEvent("b", {}))).to.equal(true);
      expect(allows(undefined, "contract=a&contract=b", contractEvent("c", {}))).to.equal(false);
    });

    it("?contract= matches an id@version by its id, and an exact label", () => {
      expect(allows(undefined, "contract=a", contractEvent("a@1.0.0", {}))).to.equal(true);
      expect(allows(undefined, "contract=a@1.0.0", contractEvent("a@1.0.0", {}))).to.equal(true);
      expect(allows(undefined, "contract=a@2", contractEvent("a@1.0.0", {}))).to.equal(false);
    });

    it("?contract= excludes an event with no contract", () => {
      expect(allows(undefined, "contract=a", own("divergence"))).to.equal(false);
    });

    it("?contract= applies to the hybrid's own events by their contract", () => {
      expect(allows(undefined, "contract=a", own("tx.committed", "a"))).to.equal(true);
      expect(allows(undefined, "contract=a", own("tx.committed", "b"))).to.equal(false);
    });

    it("?where= is equality on a top-level payload field", () => {
      expect(allows(undefined, "where=tenant:t1", contractEvent("a", { tenant: "t1" }))).to.equal(true);
      expect(allows(undefined, "where=tenant:t1", contractEvent("a", { tenant: "t2" }))).to.equal(false);
      expect(allows(undefined, "where=tenant:t1", contractEvent("a", { x: { tenant: "t1" } }))).to.equal(false);
    });

    it("?where= compares numbers and booleans by their text, never objects", () => {
      expect(allows(undefined, "where=n:42", contractEvent("a", { n: 42 }))).to.equal(true);
      expect(allows(undefined, "where=b:true", contractEvent("a", { b: true }))).to.equal(true);
      expect(allows(undefined, "where=o:[object Object]", contractEvent("a", { o: {} }))).to.equal(false);
      expect(allows(undefined, "where=o:", contractEvent("a", { o: null }))).to.equal(false);
    });

    it("?where= keeps the value after the first colon", () => {
      expect(allows(undefined, "where=k:a:b", contractEvent("a", { k: "a:b" }))).to.equal(true);
    });

    it("several ?where= must all hold", () => {
      const e = contractEvent("a", { t: "1", u: "2" });
      expect(allows(undefined, "where=t:1&where=u:2", e)).to.equal(true);
      expect(allows(undefined, "where=t:1&where=u:3", e)).to.equal(false);
    });

    it("a client where is not satisfied by an inherited property", () => {
      expect(allows(undefined, "where=toString:x", contractEvent("a", {}))).to.equal(false);
      expect(allows(undefined, "where=__proto__:x", contractEvent("a", {}))).to.equal(false);
    });

    it("a client where does not drop the hybrid's own events by kind, only by field", () => {
      expect(allows(undefined, "where=umid:u1", own("tx.committed", "a", { umid: "u1" }))).to.equal(true);
      expect(allows(undefined, "where=tenant:t1", own("tx.committed", "a"))).to.equal(false);
    });
  });

  describe("pinned contracts", () => {
    const pinned = { contracts: ["a", "b"] };

    it("serves only the pinned contracts", () => {
      expect(allows(pinned, "", contractEvent("a", {}))).to.equal(true);
      expect(allows(pinned, "", contractEvent("c", {}))).to.equal(false);
    });

    it("a client can narrow to one of them", () => {
      expect(allows(pinned, "contract=a", contractEvent("a", {}))).to.equal(true);
      expect(allows(pinned, "contract=a", contractEvent("b", {}))).to.equal(false);
    });

    it("a client cannot widen to another contract", () => {
      expect(allows(pinned, "contract=c", contractEvent("c", {}))).to.equal(false);
      expect(allows(pinned, "contract=a&contract=c", contractEvent("c", {}))).to.equal(false);
    });

    it("still serves tx.* for the pinned contracts (only a pinned where drops them)", () => {
      expect(allows(pinned, "", own("tx.committed", "a"))).to.equal(true);
      expect(allows(pinned, "", own("tx.failed", "c"))).to.equal(false);
      expect(allows(pinned, "", own("divergence"))).to.equal(false);
    });

    it("an empty pinned list serves nothing (fail closed)", () => {
      expect(allows({ contracts: [] }, "", contractEvent("a", {}))).to.equal(false);
    });
  });

  describe("pinned where", () => {
    const pinned = { where: { tenant: "t1" } };

    it("serves only matching contract events", () => {
      expect(allows(pinned, "", contractEvent("a", { tenant: "t1" }))).to.equal(true);
      expect(allows(pinned, "", contractEvent("a", { tenant: "t2" }))).to.equal(false);
    });

    it("excludes events that lack the pinned field (fail closed)", () => {
      expect(allows(pinned, "", contractEvent("a", {}))).to.equal(false);
      expect(allows(pinned, "", contractEvent("a", undefined))).to.equal(false);
      expect(allows(pinned, "", contractEvent("a", "t1"))).to.equal(false);
    });

    it("never serves tx.committed, tx.failed or divergence, even with the field", () => {
      for (const name of ["tx.committed", "tx.failed", "divergence", "adopt.undeclared"]) {
        expect(allows(pinned, "", own(name, "a", { tenant: "t1" })), name).to.equal(false);
      }
    });

    it("treats a contract event named like a hybrid event as the hybrid's (fail closed)", () => {
      expect(allows(pinned, "", contractEvent("a", { tenant: "t1" }, "divergence"))).to.equal(false);
    });

    it("a client cannot override the pinned value", () => {
      expect(allows(pinned, "where=tenant:t2", contractEvent("a", { tenant: "t2" }))).to.equal(false);
      expect(allows(pinned, "where=tenant:t2", contractEvent("a", { tenant: "t1" }))).to.equal(false);
    });

    it("a client can narrow with another field or a contract", () => {
      const e = contractEvent("a", { tenant: "t1", kind: "x" });
      expect(allows(pinned, "where=kind:x", e)).to.equal(true);
      expect(allows(pinned, "where=kind:y", e)).to.equal(false);
      expect(allows(pinned, "contract=a", e)).to.equal(true);
      expect(allows(pinned, "contract=b", e)).to.equal(false);
    });
  });

  describe("pinned contracts and where together", () => {
    const pinned = { contracts: ["a"], where: { tenant: "t1" } };
    it("needs both", () => {
      expect(allows(pinned, "", contractEvent("a", { tenant: "t1" }))).to.equal(true);
      expect(allows(pinned, "", contractEvent("b", { tenant: "t1" }))).to.equal(false);
      expect(allows(pinned, "", contractEvent("a", { tenant: "t2" }))).to.equal(false);
      expect(allows(pinned, "", own("tx.committed", "a", { tenant: "t1" }))).to.equal(false);
    });
  });

  describe("parseQuery", () => {
    it("rejects a where without field:value", () => {
      expect(() => q("where=novalue")).to.throw(FilterError);
      expect(() => q("where=:v")).to.throw(FilterError);
    });
    it("rejects two values for one field", () => {
      expect(() => q("where=t:1&where=t:2")).to.throw(FilterError);
    });
    it("rejects an unknown parameter and an empty contract", () => {
      expect(() => q("contracts=a")).to.throw(FilterError);
      expect(() => q("contract=")).to.throw(FilterError);
    });
    it("allows an empty value", () => {
      expect(q("where=t:")).to.deep.include({});
      expect(allows(undefined, "where=t:", contractEvent("a", { t: "" }))).to.equal(true);
    });
  });

  it("isOwnEvent: phase hybrid or a reserved name", () => {
    expect(isOwnEvent(own("anything"))).to.equal(true);
    expect(isOwnEvent(contractEvent("a", {}, "tx.failed"))).to.equal(true);
    expect(isOwnEvent(contractEvent("a", {}))).to.equal(false);
  });
});

describe("Hybrid events: EventLog", () => {
  let dir: string;
  let store: IEmbeddedStorage;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-events-"));
    store = await openEmbeddedStorage(dir);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes event:<ms>-<seq>,<umid> documents that eventsSince replays in order", async () => {
    let t = 1700000000000;
    const log = new EventLog(store.events, () => t);
    await log.emit({ type: "tx.committed", contract: "c", umid: "u1", payload: { umid: "u1" } });
    await log.emit({ type: "transfer", contract: "c", umid: "u1", payload: { amount: 1 } });
    t++;
    await log.emit({ type: "divergence", umid: "u2" });

    const all = await store.events.eventsSince("");
    expect(all.map(([id]) => id)).to.deep.equal([
      "1700000000000-000001,u1",
      "1700000000000-000002,u1",
      "1700000000001-000001,u2",
    ]);
    expect(all[0][1]).to.deep.equal({
      name: "tx.committed",
      data: { umid: "u1" },
      phase: "hybrid",
      contract: "c",
      umid: "u1",
    });
    expect(all[1][1]).to.include({ name: "transfer", phase: "commit", contract: "c" });
    expect(all[2][1]).to.deep.equal({ name: "divergence", data: {}, phase: "hybrid", umid: "u2" });

    const after = await store.events.eventsSince("1700000000000-000001,u1");
    expect(after.map(([id]) => id)).to.deep.equal([
      "1700000000000-000002,u1",
      "1700000000001-000001,u2",
    ]);
  });

  it("never moves backwards when the clock does", async () => {
    let t = 2000;
    const log = new EventLog(store.events, () => t);
    const a = log.nextId("u");
    t = 1000;
    const b = log.nextId("u");
    expect(b > a).to.equal(true);
  });

  it("refuses an event with no type", async () => {
    const log = new EventLog(store.events);
    let err: any;
    await log.emit({} as any).catch((e) => (err = e));
    expect(err).to.be.instanceOf(Error);
  });

  it("the filter applies to replayed documents as stored", async () => {
    const log = new EventLog(store.events);
    await log.emit({ type: "tx.committed", contract: "a", umid: "u" });
    await log.emit({ type: "minted", contract: "a", umid: "u", payload: { tenant: "t1" } });
    await log.emit({ type: "minted", contract: "a", umid: "u", payload: { tenant: "t2" } });
    const f = new EventFilter({ where: { tenant: "t1" } });
    const served = (await store.events.eventsSince("")).filter(([, e]) => f.allows(e));
    expect(served.map(([, e]) => (e as any).data)).to.deep.equal([{ tenant: "t1" }]);
  });
});
