import {
  EmbeddedDSConnect,
  IEmbeddedStorage,
  openEmbeddedStorage,
} from "../packages/storage/src/embedded";
import { LevelMe } from "../packages/storage/src/levelme";
import { ActiveDSConnect } from "../packages/options/src/dsconnect";
import { ActiveOptions } from "../packages/options/src/options";
import { expect } from "chai";
import "mocha";
import * as child from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * EmbeddedDSConnect answers the ActiveDSConnect calls from a LevelMe in this
 * process. A caller must not be able to tell it from ActiveDSConnect talking
 * to the storage process (selfhost.ts), so the strongest checks below run
 * the same calls against both and compare what comes back.
 */
describe("EmbeddedDSConnect (Activestorage)", () => {
  let tmpDir: string;
  let storage: IEmbeddedStorage;
  let db: EmbeddedDSConnect;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-embedded-"));
    storage = await openEmbeddedStorage(tmpDir);
    db = storage.data;
  });

  afterEach(async () => {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("layout", () => {
    it("opens one LevelDB directory per database inside the data directory", () => {
      const dirs = fs.readdirSync(tmpDir).sort();
      expect(dirs).to.deep.equal([
        "activeledger",
        "activeledgererrors",
        "activeledgerevents",
      ]);
    });

    it("refuses a database name the storage process would refuse", () => {
      expect(() => new EmbeddedDSConnect(tmpDir + path.sep, "../escape")).to.throw(
        "invalid database"
      );
    });

    it("info() reports the database name and a data size", async () => {
      const info = await db.info();
      expect(info.db_name).to.equal("activeledger");
      expect(info.data_size).to.be.a("number").greaterThan(0);
    });
  });

  describe("round trip", () => {
    it("post / get / exists", async () => {
      const res = await db.post({ _id: "s1", value: 1 });
      expect(res.ok).to.equal(true);
      expect(res.id).to.equal("s1");
      expect(res.rev).to.match(/^1-[0-9a-f]{32}$/);

      const doc = await db.get("s1");
      expect(doc).to.deep.equal({ _id: "s1", value: 1, _rev: res.rev });
      expect(await db.exists("s1")).to.equal(true);
      expect(await db.exists("missing")).to.equal(false);
    });

    it("post without an _id generates one", async () => {
      const res = await db.post({ value: 1 });
      expect(res.id).to.be.a("string").and.not.equal("");
      expect((await db.get(res.id)).value).to.equal(1);
    });

    it("does not touch the caller's object, and callers cannot reach the cache", async () => {
      const input: any = { _id: "s1", value: 1 };
      await db.post(input);
      expect(input).to.deep.equal({ _id: "s1", value: 1 });

      const first = await db.get("s1");
      first.value = 999;
      expect((await db.get("s1")).value).to.equal(1);
    });

    it("put writes the body's document", async () => {
      const res = await db.put({ _id: "s1", value: 1 } as any);
      expect(res.ok).to.equal(true);
      expect((await db.get("s1")).value).to.equal(1);
    });

    it("allDocs by keys, and by range", async () => {
      await db.bulkDocs([{ _id: "a" }, { _id: "b" }, { _id: "c" }], { new_edits: true });
      const byKeys = await db.allDocs({ keys: ["a", "c"], include_docs: true });
      expect(byKeys.rows.map((r: any) => r.doc._id).sort()).to.deep.equal(["a", "c"]);

      const all = await db.allDocs();
      expect(all.rows.map((r: any) => r.id)).to.deep.equal(["a", "b", "c"]);
    });

    it("allDocs rows carry the revision the way CouchDB's do, which /a/all reads", async () => {
      await db.bulkDocs([{ _id: "a" }], { new_edits: true });
      const { _rev } = await db.get("a");
      const all = await db.allDocs();
      expect(all.rows[0].value).to.deep.equal({ rev: _rev });
      expect(_rev).to.be.a("string");
    });

    it("purge removes the document", async () => {
      await db.post({ _id: "s1", value: 1 });
      expect(await db.purge({ _id: "s1" })).to.deep.equal({ success: "ok" });
      expect(await db.exists("s1")).to.equal(false);
    });
  });

  describe("bulkDocs", () => {
    it("new_edits true numbers revisions forward", async () => {
      expect(await db.bulkDocs([{ _id: "s1", v: 1 }], { new_edits: true })).to.deep.equal({ ok: true });
      const r1 = (await db.get("s1"))._rev;
      expect(r1.startsWith("1-")).to.equal(true);

      await db.bulkDocs([{ _id: "s1", v: 2, _rev: r1 }], { new_edits: true });
      expect((await db.get("s1"))._rev.startsWith("2-")).to.equal(true);
    });

    it("new_edits false keeps the given revision for a new document", async () => {
      await db.bulkDocs([{ _id: "s1", v: 1, _rev: "7-abc" }], { new_edits: false });
      expect((await db.get("s1"))._rev).to.equal("7-abc");
    });

    it("new_edits false at a stale revision fails the way the HTTP path does", async () => {
      await db.bulkDocs([{ _id: "s1", v: 1 }], { new_edits: true });
      // LevelMe rejects; over HTTP that is a 500 whose body is the
      // serialised Error, which has no enumerable properties.
      const res = await db.bulkDocs([{ _id: "s1", v: 2, _rev: "1-stale" }], { new_edits: false });
      expect(res).to.deep.equal({});
      expect((await db.get("s1")).v).to.equal(1);
    });

    it("force_rev sets the revision exactly", async () => {
      await db.bulkDocs([{ _id: "s1", v: 1 }], { new_edits: true });
      await db.bulkDocs([{ _id: "s1", v: 2 }], { new_edits: true, force_rev: "9-forced" });
      const doc = await db.get("s1");
      expect(doc._rev).to.equal("9-forced");
      expect(doc.v).to.equal(2);
    });

    it("produces the same revisions as LevelMe used directly", async () => {
      const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-embedded-ref-"));
      // Different name: LevelMe's cache is process-wide per name.
      const ref = new LevelMe(refDir + path.sep, "activeledgerref", "level");
      try {
        const steps: Array<[any[], any]> = [
          [[{ _id: "s1", v: 1 }], { new_edits: true }],
          [[{ _id: "s1", v: 2 }], { new_edits: true }],
          [[{ _id: "s1", v: 2 }], { new_edits: true }], // unchanged content
          [[{ _id: "s2", v: 1, _rev: "3-xyz" }], { new_edits: false }],
          [[{ _id: "s1", v: 3 }], { new_edits: true, force_rev: "8-f" }],
          [[{ _id: "s1", v: 4 }], { new_edits: true }],
        ];
        for (const [docs, options] of steps) {
          await db.bulkDocs(JSON.parse(JSON.stringify(docs)), options);
          await ref.bulkDocs(JSON.parse(JSON.stringify(docs)), options);
          for (const id of ["s1", "s2"]) {
            const mine = await db.get(id);
            let theirs: any = null;
            try {
              theirs = await ref.get(id);
            } catch {}
            expect(mine?._rev, id).to.equal(theirs?._rev);
          }
        }
        expect((await db.get("s1"))._rev.startsWith("9-")).to.equal(true);
      } finally {
        await ref.close();
        fs.rmSync(refDir, { recursive: true, force: true });
      }
    });
  });

  describe("cache", () => {
    it("a read after a write returns the new document", async () => {
      await db.post({ _id: "s1", value: "first" });
      expect((await db.get("s1")).value).to.equal("first"); // warm the cache
      await db.bulkDocs([{ _id: "s1", value: "second" }], { new_edits: true });
      expect((await db.get("s1")).value).to.equal("second");
      await db.post({ _id: "s1", value: "third" });
      expect((await db.get("s1")).value).to.equal("third");
    });

    it("the multi-key path is invalidated too", async () => {
      await db.post({ _id: "s1", value: "first" });
      await db.allDocs({ keys: ["s1"], include_docs: true });
      await db.bulkDocs([{ _id: "s1", value: "second" }], { new_edits: true });
      const res = await db.allDocs({ keys: ["s1"], include_docs: true });
      expect(res.rows[0].doc.value).to.equal("second");
    });
  });

  describe("not found", () => {
    it("resolves (does not reject) with the serialised store error", async () => {
      const res = await db.get("missing");
      expect(res).to.include({ notFound: true, code: "LEVEL_NOT_FOUND" });
      // What nano-gateway's looksLikeDoc() rejects
      expect(typeof res._id).to.equal("undefined");
    });
  });

  describe("events", () => {
    it("eventsSince returns the events after a cursor, oldest first", async () => {
      const events = storage.events;
      for (const n of ["1", "2", "3"]) {
        await events.post({ _id: "event:" + n, name: "e" + n });
      }
      const missed = await events.eventsSince("1");
      expect(missed).to.deep.equal([
        ["2", { name: "e2" }],
        ["3", { name: "e3" }],
      ]);
    });

    it("writes are announced on the store's change feed", async () => {
      const seen: string[] = [];
      const listener = (change: any) => seen.push(change.id);
      storage.events.level.changes().on("change", listener);
      try {
        await storage.events.post({ _id: "event:9", name: "e9" });
        await storage.events.bulkDocs([{ _id: "event:10" }, { _id: "event:11" }], { new_edits: true });
      } finally {
        storage.events.level.changes().off("change", listener);
      }
      expect(seen.sort()).to.deep.equal(["event:10", "event:11", "event:9"]);
    });
  });

  /**
   * The same calls against the real storage process, through
   * ActiveDSConnect. Needs the built storage package (npm run build).
   */
  describe("matches ActiveDSConnect over HTTP", function () {
    this.timeout(30000);

    const selfhost = path.join(__dirname, "../packages/storage/lib/selfhost.js");
    let httpDir: string;
    let proc: child.ChildProcess;
    let http: ActiveDSConnect;
    let previousDb: any;

    const freePort = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
          const port = (srv.address() as net.AddressInfo).port;
          srv.close(() => resolve(port));
        });
        srv.on("error", reject);
      });

    before(async function () {
      if (!fs.existsSync(selfhost)) {
        throw new Error(`${selfhost} missing - run npm run build first`);
      }
      // ActiveDSConnect.purge() uses the self-hosted route only when told
      previousDb = ActiveOptions.get<any>("db", undefined);
      ActiveOptions.set("db", { selfhost: {} });

      httpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-embedded-http-"));
      const port = await freePort();
      // selfhost.ts prefixes "./" to its directory argument
      proc = child.spawn("node", [selfhost, ".", `${port}`, "level"], {
        cwd: httpDir,
        stdio: "ignore",
      });
      const root = `http://127.0.0.1:${port}`;
      http = new ActiveDSConnect(`${root}/activeledger`);
      const deadline = Date.now() + 20000;
      for (;;) {
        if ((await http.info())?.db_name === "activeledger") break;
        if (Date.now() > deadline) throw new Error("storage process did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    after(() => {
      proc?.kill("SIGKILL");
      if (httpDir) fs.rmSync(httpDir, { recursive: true, force: true });
      ActiveOptions.set("db", previousDb);
    });

    // Each step is run against both; results must be identical.
    const steps: Array<[string, (c: any) => Promise<any>]> = [
      ["get missing", (c) => c.get("nope")],
      ["exists missing", (c) => c.exists("nope")],
      ["post", (c) => c.post({ _id: "d1", v: 1 })],
      ["get", (c) => c.get("d1")],
      ["exists", (c) => c.exists("d1")],
      ["get prefixed", (c) => c.get("d1:stream")],
      ["bulk new_edits true", (c) => c.bulkDocs([{ _id: "d1", v: 2 }, { _id: "d2", v: 1 }], { new_edits: true })],
      ["get after bulk", (c) => c.get("d1")],
      ["bulk default options", (c) => c.bulkDocs([{ _id: "d3", v: 1, _rev: "4-x" }])],
      ["get d3", (c) => c.get("d3")],
      ["bulk stale new_edits false", (c) => c.bulkDocs([{ _id: "d1", v: 9, _rev: "1-old" }], { new_edits: false })],
      ["bulk force_rev", (c) => c.bulkDocs([{ _id: "d2", v: 5 }], { new_edits: true, force_rev: "6-z" })],
      ["get d2", (c) => c.get("d2")],
      ["put", (c) => c.put({ _id: "d4", v: 1 })],
      ["put stale", (c) => c.put({ _id: "d4", v: 2, _rev: "5-nope" })],
      ["allDocs keys", (c) => c.allDocs({ keys: ["d1", "missing", "d2"], include_docs: true })],
      ["allDocs range", (c) => c.allDocs({ startkey: "d", endkey: "d3", include_docs: true })],
      ["allDocs limit", (c) => c.allDocs({ limit: "2" })],
      ["allDocs none", (c) => c.allDocs()],
      ["purge", (c) => c.purge({ _id: "d4" })],
      ["get purged", (c) => c.get("d4")],
    ];

    it("gives the same answers for the same calls", async () => {
      for (const [label, step] of steps) {
        const viaHttp = await step(http);
        const embedded = await step(db);
        // Every step here gets a real answer over HTTP; null would mean the
        // comparison proved nothing.
        expect(viaHttp, label).to.not.equal(null);
        expect(embedded, label).to.deep.equal(viaHttp);
      }
    });
  });
});
