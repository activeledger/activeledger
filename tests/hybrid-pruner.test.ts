import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { Pruner } from "../packages/hybrid/src/pruner";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-23T12:00:00Z");
const ME = "-----BEGIN PUBLIC KEY-----\nme\n-----END PUBLIC KEY-----";

describe("Hybrid pruner (storage window)", () => {
  let dir: string;
  let store: IEmbeddedStorage;

  const umidDoc = (umid: string, ageDays: number | null, relayKey?: string) => ({
    _id: `${umid}:umid`,
    umid: {
      $umid: umid,
      $tx: {},
      ...(ageDays === null ? {} : { $datetime: new Date(NOW - ageDays * DAY).toISOString() }),
      ...(relayKey ? { $relay: { key: relayKey, sig: "s" } } : {}),
    },
    streams: {},
    events: [],
  });

  const has = async (db: any, id: string) => (await db.get(id))?._id === id;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pruner-"));
    store = await openEmbeddedStorage(dir);
    const d = store.data;
    // A stream whose meta points at an old umid
    await d.post({ _id: "s1", balance: 1 });
    await d.post({ _id: "s1:stream", umid: "current", authorities: [] });
    await d.post({ _id: "s1:volatile", secret: 1 });
    await d.post({ _id: "c1:data", x: 1 });
    await d.post(umidDoc("current", 400));
    await d.post(umidDoc("old", 31));
    await d.post(umidDoc("old2", 90));
    await d.post(umidDoc("recent", 29));
    await d.post(umidDoc("mine", 400, ME));
    await d.post(umidDoc("theirs", 400, "someone else"));
    await d.post(umidDoc("undated", null));

    const e = store.events;
    await e.post({ _id: `event:${NOW - 31 * DAY}-1,old`, name: "x", data: {} });
    await e.post({ _id: `event:${NOW - 40 * DAY}-000001,old2`, name: "x", data: {} });
    await e.post({ _id: `event:${NOW - 1 * DAY}-1,new`, name: "x", data: {} });
    await e.post({ _id: "umid:somecursor", keep: true });
    await e.post({ _id: "divergence:old", at: new Date(NOW - 400 * DAY).toISOString() });
    await store.errors.post({ _id: "err1", at: 0 });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pruner = (over: any = {}) =>
    new Pruner({ store, config: { window: { days: 30 } }, publicPem: ME, now: () => NOW, ...over });

  it("deletes only :umid docs and events outside the window", async () => {
    const counts = await pruner({ pageSize: 2 }).run();
    expect(counts.dryRun).to.equal(false);
    expect(counts.umids).to.deep.equal({
      scanned: 7,
      pruned: 3,
      keptCurrent: 1,
      keptRelayed: 1,
      keptRecent: 1,
      keptUndated: 1,
    });
    expect(counts.events).to.deep.equal({ scanned: 2, pruned: 2 });

    const d = store.data;
    for (const id of ["s1", "s1:stream", "s1:volatile", "c1:data", "current:umid", "recent:umid", "mine:umid", "undated:umid"]) {
      expect(await has(d, id), id).to.equal(true);
    }
    for (const id of ["old:umid", "old2:umid", "theirs:umid"]) {
      expect(await has(d, id), id).to.equal(false);
    }
    const e = store.events;
    expect(await has(e, `event:${NOW - 1 * DAY}-1,new`)).to.equal(true);
    expect(await has(e, `event:${NOW - 31 * DAY}-1,old`)).to.equal(false);
    expect(await has(e, "umid:somecursor")).to.equal(true);
    expect(await has(e, "divergence:old")).to.equal(true);
    expect(await has(store.errors, "err1")).to.equal(true);
  });

  it("dryRun counts without deleting", async () => {
    const counts = await pruner().run({ dryRun: true });
    expect(counts.dryRun).to.equal(true);
    expect(counts.umids.pruned).to.equal(3);
    expect(counts.events.pruned).to.equal(2);
    expect(await has(store.data, "old:umid")).to.equal(true);
    expect(await has(store.events, `event:${NOW - 31 * DAY}-1,old`)).to.equal(true);
  });

  it("a wider window keeps more", async () => {
    const counts = await pruner({ config: { window: { days: 100 } } }).run();
    expect(counts.umids.pruned).to.equal(1); // only theirs (400d); old2 (90d) and old (31d) kept
    expect(await has(store.data, "old2:umid")).to.equal(true);
  });

  it("never deletes a umid a meta starts pointing at during the run", async () => {
    const level: any = store.data.level;
    const original = level.allDocs.bind(level);
    let calls = 0;
    level.allDocs = async (opts: any) => {
      const r = await original(opts);
      // After pass 2 has listed "old" as a candidate, a commit points a
      // stream at it
      if (++calls === 2) await store.data.post({ _id: "s2:stream", umid: "old" });
      return r;
    };
    const counts = await pruner().run();
    level.allDocs = original;
    expect(await has(store.data, "old:umid")).to.equal(true);
    expect(await has(store.data, "old2:umid")).to.equal(false);
    expect(counts.umids.pruned).to.equal(2);
  });

  it("refuses a nonsense window", async () => {
    let err: any;
    await pruner({ config: { window: { days: 0 } } })
      .run()
      .catch((e: any) => (err = e));
    expect(err).to.be.instanceOf(Error);
  });

  it("concurrent runs share one pass", async () => {
    const p = pruner();
    const [a, b] = await Promise.all([p.run(), p.run()]);
    expect(a).to.equal(b);
  });

  it("start runs on the interval and stop ends it", async () => {
    const p = pruner({ intervalMs: 10 });
    p.start();
    for (let i = 0; i < 100 && (await has(store.data, "old:umid")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    p.stop();
    expect(await has(store.data, "old:umid")).to.equal(false);
  });
});
