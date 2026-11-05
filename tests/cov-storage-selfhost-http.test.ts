import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";
import {
  Storage,
  killAll,
  openStream,
  startStorage,
} from "./cov-storage-harness";

const REV = /^\d+-[0-9a-f]{32}$/;

/**
 * The storage process (packages/storage/lib/selfhost.js) driven over HTTP:
 * routing, validation and the exact status codes and bodies it answers with.
 */
describe("Storage process HTTP API (selfhost)", function () {
  this.timeout(60000);
  let s: Storage;

  before(async () => {
    s = await startStorage(["level"]);
  });

  after(async () => {
    await s?.stop();
    s?.cleanup();
    killAll();
  });

  describe("service routes", () => {
    it("welcomes on / and names the engine it was started with", async () => {
      const r = await s.req("GET", "/");
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({
        activeledger: "Welcome to Activeledger data!",
        adapters: ["levelme"],
        engine: "level",
      });
    });

    it("answers _session as an admin without a name", async () => {
      const r = await s.req("GET", "/_session");
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({
        ok: true,
        userCtx: { name: null, roles: ["_admin"] },
      });
    });

    it("sets permissive CORS headers and a json content type", async () => {
      const r = await s.req("GET", "/_session");
      expect(r.headers["access-control-allow-origin"]).to.equal("*");
      expect(r.headers["content-type"]).to.equal("application/json");
    });

    it("generates as many unique uuids as asked for", async () => {
      const r = await s.req("GET", "/_uuids?count=4");
      expect(r.status).to.equal(200);
      expect(r.json.uuids).to.have.length(4);
      for (const u of r.json.uuids) {
        expect(u).to.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
      }
      expect(new Set(r.json.uuids).size).to.equal(4);
    });

    it("generates none for count=0 or when no count is given", async () => {
      expect((await s.req("GET", "/_uuids?count=0")).json).to.deep.equal({
        uuids: [],
      });
      expect((await s.req("GET", "/_uuids")).json).to.deep.equal({ uuids: [] });
    });

    it("answers _find and _explain as deprecated", async () => {
      const f = await s.req("POST", "/activeledger/_find", {});
      expect(f.status).to.equal(200);
      expect(f.json).to.deep.equal({ error: "find is deprecated" });
      const e = await s.req("POST", "/activeledger/_explain", {});
      expect(e.status).to.equal(200);
      expect(e.json).to.deep.equal({ error: "explain is deprecated" });
    });
  });

  describe("database names", () => {
    it("refuses a name that does not start with activeledger", async () => {
      const r = await s.req("GET", "/notadb");
      expect(r.status).to.equal(500);
      expect(fs.existsSync(path.join(s.dir, "data", "notadb"))).to.equal(false);
    });

    it("is case sensitive about the prefix", async () => {
      expect((await s.req("GET", "/Activeledger")).status).to.equal(500);
    });

    it("accepts a suffix of up to 64 name characters and refuses 65", async () => {
      const ok = "activeledger" + "a".repeat(64);
      const bad = "activeledger" + "a".repeat(65);
      expect((await s.req("GET", `/${ok}`)).status).to.equal(200);
      expect((await s.req("GET", `/${bad}`)).status).to.equal(500);
      expect(fs.existsSync(path.join(s.dir, "data", bad))).to.equal(false);
    });

    it("refuses suffix characters outside letters, digits, _ and -", async () => {
      expect((await s.req("GET", "/activeledger.x")).status).to.equal(500);
      expect((await s.req("GET", "/activeledger%20x")).status).to.equal(500);
      expect((await s.req("GET", "/activeledger_x-9")).status).to.equal(200);
    });

    it("creating a database by PUT makes its folder and reports ok", async () => {
      const r = await s.req("PUT", "/anything", { name: "activeledgercreated" });
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ ok: true });
      expect(
        fs.statSync(path.join(s.dir, "data", "activeledgercreated")).isDirectory()
      ).to.equal(true);
    });

    it("refuses to create a database with an invalid name", async () => {
      for (const name of ["../evil", "other", "activeledger/../x"]) {
        const r = await s.req("PUT", "/anything", { name });
        expect(r.status, name).to.equal(500);
      }
      expect(fs.existsSync(path.join(s.dir, "evil"))).to.equal(false);
      expect(fs.existsSync(path.join(s.dir, "data", "other"))).to.equal(false);
    });

    it("lists only database folders in _all_dbs", async () => {
      const data = path.join(s.dir, "data");
      fs.mkdirSync(path.join(data, "_replicator"));
      fs.mkdirSync(path.join(data, "pouch__all_dbs__"));
      fs.mkdirSync(path.join(data, "activeledger-mrview-x"));
      fs.mkdirSync(path.join(data, "data"));
      fs.writeFileSync(path.join(data, "loose-file"), "x");
      await s.req("PUT", "/x", { name: "activeledgerlisted" });
      const r = await s.req("GET", "/_all_dbs");
      expect(r.status).to.equal(200);
      expect(r.json).to.include("activeledgerlisted");
      expect(r.json).to.include("activeledgercreated");
      for (const hidden of [
        "_replicator",
        "pouch__all_dbs__",
        "activeledger-mrview-x",
        "data",
        "loose-file",
      ]) {
        expect(r.json, hidden).to.not.include(hidden);
      }
    });

    it("reports database info with the on disk size", async () => {
      await s.req("PUT", "/x", { name: "activeledgerinfo" });
      const r = await s.req("GET", "/activeledgerinfo");
      expect(r.status).to.equal(200);
      expect(r.json.db_name).to.equal("activeledgerinfo");
      expect(r.json.update_seq).to.equal(0);
      expect(r.json.doc_count).to.equal("----");
      const dir = path.join(s.dir, "data", "activeledgerinfo");
      const expected = fs
        .readdirSync(dir)
        .reduce((t, f) => t + fs.statSync(path.join(dir, f)).size, 0);
      expect(r.json.data_size).to.be.greaterThan(0);
      expect(r.json.data_size).to.equal(expected);
    });

    it("deleting a database removes its folder, and deleting it again is ok", async () => {
      await s.req("PUT", "/x", { name: "activeledgerdoomed" });
      await s.req("POST", "/activeledgerdoomed", { _id: "d1", v: 1 });
      const dir = path.join(s.dir, "data", "activeledgerdoomed");
      expect(fs.existsSync(dir)).to.equal(true);
      const r = await s.req("DELETE", "/activeledgerdoomed");
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ ok: true });
      expect(fs.existsSync(dir)).to.equal(false);
      const again = await s.req("DELETE", "/activeledgerdoomed");
      expect(again.status).to.equal(200);
      expect(again.json).to.deep.equal({ ok: true });
      // It can be recreated empty afterwards
      await s.req("POST", "/activeledgerdoomed", { _id: "d2", v: 2 });
      expect((await s.req("GET", "/activeledgerdoomed/d1")).status).to.equal(500);
      expect((await s.req("GET", "/activeledgerdoomed/d2")).json.v).to.equal(2);
    });

    it("deleting a database that was never opened removes it from disk", async () => {
      const dir = path.join(s.dir, "data", "activeledgerforeign");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "junk"), "x");
      const r = await s.req("DELETE", "/activeledgerforeign");
      expect(r.json).to.deep.equal({ ok: true });
      expect(fs.existsSync(dir)).to.equal(false);
    });
  });

  describe("documents", () => {
    const db = "activeledger";

    it("POST stores a document and returns its id and a revision", async () => {
      const r = await s.req("POST", `/${db}`, { _id: "doc1", n: 1 });
      expect(r.status).to.equal(200);
      expect(r.json.ok).to.equal(true);
      expect(r.json.id).to.equal("doc1");
      expect(r.json.rev).to.match(REV);
      expect(r.json.rev.startsWith("1-")).to.equal(true);
    });

    it("GET returns the stored document with its revision", async () => {
      const w = await s.req("POST", `/${db}`, { _id: "doc2", n: 2, deep: { a: [1, 2] } });
      const r = await s.req("GET", `/${db}/doc2`);
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({
        _id: "doc2",
        n: 2,
        deep: { a: [1, 2] },
        _rev: w.json.rev,
      });
    });

    it("POST of a body that is not an object is a 500 carrying a reason", async () => {
      const r = await s.req("POST", `/${db}`, "just a string");
      expect(r.status).to.equal(500);
      expect(r.json.reason).to.be.a("string").that.is.not.empty;
    });

    it("PUT of a body that is not a document is a 500 carrying a reason", async () => {
      const r = await s.req("PUT", `/${db}/x`, "just a string");
      expect(r.status).to.equal(500);
      expect(r.json.reason).to.be.a("string").that.is.not.empty;
    });

    it("POST without an _id generates a uuid one", async () => {
      const r = await s.req("POST", `/${db}`, { n: 3 });
      expect(r.status).to.equal(200);
      expect(r.json.id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      const got = await s.req("GET", `/${db}/${r.json.id}`);
      expect(got.json.n).to.equal(3);
      expect(got.json._id).to.equal(r.json.id);
    });

    it("writing the same id again advances the revision and replaces the body", async () => {
      const a = await s.req("POST", `/${db}`, { _id: "doc4", v: "first" });
      const b = await s.req("POST", `/${db}`, { _id: "doc4", v: "second" });
      expect(b.json.rev.startsWith("2-")).to.equal(true);
      expect(b.json.rev).to.not.equal(a.json.rev);
      const got = await s.req("GET", `/${db}/doc4`);
      expect(got.json.v).to.equal("second");
      expect(got.json._rev).to.equal(b.json.rev);
    });

    it("PUT stores a document under its body id", async () => {
      const r = await s.req("PUT", `/${db}/doc5`, { _id: "doc5", v: 5 });
      expect(r.status).to.equal(200);
      expect(r.json.ok).to.equal(true);
      expect(r.json.id).to.equal("doc5");
      expect((await s.req("GET", `/${db}/doc5`)).json.v).to.equal(5);
    });

    it("PUT of a nested path is handled by the same route", async () => {
      const r = await s.req("PUT", `/${db}/a/b/c`, { _id: "deep1", v: 1 });
      expect(r.status).to.equal(200);
      expect(r.json.id).to.equal("deep1");
    });

    it("GET of a missing document is a 500 that says not found", async () => {
      const r = await s.req("GET", `/${db}/never-written`);
      expect(r.status).to.equal(500);
      expect(r.json.notFound).to.equal(true);
      expect(r.json.code).to.equal("LEVEL_NOT_FOUND");
    });

    it("decodes a percent encoded id", async () => {
      await s.req("POST", `/${db}`, { _id: "with space", v: 1 });
      const r = await s.req("GET", `/${db}/with%20space`);
      expect(r.status).to.equal(200);
      expect(r.json._id).to.equal("with space");
    });

    it("on the ledger database only the last 64 characters of a long id count", async () => {
      const id = "f".repeat(64);
      await s.req("POST", `/${db}`, { _id: id, v: "ledger" });
      const r = await s.req("GET", `/${db}/${"e".repeat(10)}${id}`);
      expect(r.status).to.equal(200);
      expect(r.json.v).to.equal("ledger");
    });

    it("keeps a 0x prefixed long id whole", async () => {
      const id = "0x" + "a".repeat(70);
      await s.req("POST", `/${db}`, { _id: id, v: "hex" });
      expect((await s.req("GET", `/${db}/${id}`)).json.v).to.equal("hex");
      expect((await s.req("GET", `/${db}/zz${id}`)).status).to.equal(500);
    });

    it("keeps a :suffix when trimming the id", async () => {
      const id = "d".repeat(64);
      await s.req("POST", `/${db}`, { _id: `${id}:volatile`, v: "vol" });
      const r = await s.req("GET", `/${db}/xx${id}:volatile`);
      expect(r.status).to.equal(200);
      expect(r.json.v).to.equal("vol");
    });

    it("does not trim ids on other databases", async () => {
      const other = "activeledgeraux";
      const id = "c".repeat(64);
      await s.req("POST", `/${other}`, { _id: id, v: "aux" });
      expect((await s.req("GET", `/${other}/${id}`)).json.v).to.equal("aux");
      expect((await s.req("GET", `/${other}/ab${id}`)).status).to.equal(500);
    });

    it("DELETE of a document removes it and answers success", async () => {
      await s.req("POST", `/${db}`, { _id: "gone", v: 1 });
      const r = await s.req("DELETE", `/${db}/gone`);
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ success: "ok" });
      expect((await s.req("GET", `/${db}/gone`)).status).to.equal(500);
    });

    it("DELETE of a missing document is also a success", async () => {
      const r = await s.req("DELETE", `/${db}/was-never-here`);
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ success: "ok" });
    });

    it("DELETE decodes a percent encoded id", async () => {
      await s.req("POST", `/${db}`, { _id: "del me", v: 1 });
      await s.req("DELETE", `/${db}/del%20me`);
      expect((await s.req("GET", `/${db}/del%20me`)).status).to.equal(500);
    });

    it("GET _raw returns the stored root document", async () => {
      const w = await s.req("POST", `/${db}`, { _id: "rawdoc", v: 9 });
      const r = await s.req("GET", `/${db}/_raw/rawdoc`);
      expect(r.status).to.equal(200);
      expect(r.json._id).to.equal("rawdoc");
      expect(r.json.v).to.equal(9);
      expect(r.json._rev).to.equal(w.json.rev);
    });

    it("GET _raw of a missing document is a not found 500", async () => {
      const r = await s.req("GET", `/${db}/_raw/missing-raw`);
      expect(r.status).to.equal(500);
      expect(r.json.notFound).to.equal(true);
    });

    it("GET _raw with an unknown revision fails the revision fetch", async () => {
      await s.req("POST", `/${db}`, { _id: "rawrev", v: 1 });
      const r = await s.req("GET", `/${db}/_raw/rawrev@1-nonexistent`);
      expect(r.status).to.equal(500);
    });
  });

  describe("_all_docs", () => {
    const db = "activeledgeralldocs";

    before(async () => {
      for (const id of ["k1", "k2", "k3", "k4"]) {
        await s.req("POST", `/${db}`, { _id: id, order: id });
      }
    });

    it("lists the rows with id, key and rev", async () => {
      const r = await s.req("GET", `/${db}/_all_docs`);
      expect(r.status).to.equal(200);
      expect(r.json.total_rows).to.equal(4);
      expect(r.json.offset).to.equal(0);
      expect(r.json.rows.map((x: any) => x.id)).to.deep.equal(["k1", "k2", "k3", "k4"]);
      expect(r.json.rows[0].key).to.equal("k1");
      expect(r.json.rows[0].value.rev).to.match(REV);
    });

    it("limits the rows, parsing the limit from the query string", async () => {
      const r = await s.req("GET", `/${db}/_all_docs?limit=2`);
      expect(r.json.rows.map((x: any) => x.id)).to.deep.equal(["k1", "k2"]);
    });

    it("starts at startkey, with quotes removed", async () => {
      const r = await s.req("GET", `/${db}/_all_docs?startkey=%22k3%22`);
      expect(r.json.rows.map((x: any) => x.id)).to.deep.equal(["k3", "k4"]);
    });

    it("includes the documents when asked", async () => {
      const r = await s.req("GET", `/${db}/_all_docs?include_docs=true&limit=1`);
      expect(r.json.rows).to.have.length(1);
      expect(r.json.rows[0]._id).to.equal("k1");
      expect(r.json.rows[0].order).to.equal("k1");
    });

    it("POST takes the same options from the body", async () => {
      const r = await s.req("POST", `/${db}/_all_docs`, { startkey: "k2", limit: 2 });
      expect(r.status).to.equal(200);
      expect(r.json.rows.map((x: any) => x.id)).to.deep.equal(["k2", "k3"]);
    });

    it("POST with keys returns just those documents", async () => {
      const r = await s.req("POST", `/${db}/_all_docs`, { keys: ["k4", "k1"] });
      expect(r.status).to.equal(200);
      const docs = r.json.rows.map((x: any) => x.doc);
      expect(docs.map((d: any) => d._id).sort()).to.deep.equal(["k1", "k4"]);
    });

    it("POST with keys trims long ledger ids to their last 64 characters", async () => {
      const ledger = "activeledger";
      const id = "b".repeat(64);
      await s.req("POST", `/${ledger}`, { _id: id, v: "keyed" });
      const r = await s.req("POST", `/${ledger}/_all_docs`, {
        keys: ["zzzz" + id],
      });

    it("stops at endkey, which matches by prefix with quotes removed", async () => {
      await s.req("POST", `/${db}`, { _id: "m1", order: "m1" });
      // The last character of endkey is replaced by a very high one, so the
      // range runs to the end of everything starting "k"
      const r = await s.req("GET", `/${db}/_all_docs?endkey=%22k2%22`);
      expect(r.json.rows.map((x: any) => x.id)).to.deep.equal(["k1", "k2", "k3", "k4"]);
      const m = await s.req("GET", `/${db}/_all_docs?startkey=k4&endkey=m1`);
      expect(m.json.rows.map((x: any) => x.id)).to.deep.equal(["k4", "m1"]);
    });
      expect(r.json.rows.map((x: any) => x.doc._id)).to.deep.equal([id]);
    });
  });

  describe("umids and transactions", () => {
    const db = "activeledgerumids";

    before(async () => {
      await s.req("POST", `/${db}`, { _id: "umid:100,aaa", t: 1 });
      await s.req("POST", `/${db}`, { _id: "umid:200,bbb", t: 2 });
      await s.req("POST", `/${db}`, { _id: "umid:300,ccc", t: 3 });
      // Documents that sort after every umid: key must not come back as rows
      await s.req("POST", `/${db}`, { _id: "with space", t: 4 });
      await s.req("POST", `/${db}`, { _id: "zzz", t: 5 });
    });

    it("lists transaction rows from a timestamp as umid and timestamp", async () => {
      const r = await s.req("GET", `/${db}/umids?from=200`);
      expect(r.status).to.equal(200);
      expect(r.json.rows).to.deep.equal([
        { umid: "bbb", timestamp: "200" },
        { umid: "ccc", timestamp: "300" },
      ]);
    });

    it("accepts a from that already carries the umid: prefix", async () => {
      const r = await s.req("GET", `/${db}/umids?from=umid:300`);
      expect(r.json.rows).to.deep.equal([{ umid: "ccc", timestamp: "300" }]);
    });

    it("serves the same data on /transactions, honouring limit", async () => {
      const r = await s.req("GET", `/${db}/transactions?from=100&limit=2`);
      expect(r.json.rows).to.deep.equal([
        { umid: "aaa", timestamp: "100" },
        { umid: "bbb", timestamp: "200" },
      ]);
    });

    it("stops at the end of the umid: keys instead of returning other documents", async () => {
      const r = await s.req("GET", `/${db}/umids?from=100`);
      expect(r.json.rows).to.deep.equal([
        { umid: "aaa", timestamp: "100" },
        { umid: "bbb", timestamp: "200" },
        { umid: "ccc", timestamp: "300" },
      ]);
    });

    it("answers an error status when from is missing", async () => {
      const r = await s.req("GET", `/${db}/umids`);
      expect(r.status).to.equal(500);
    });
  });

  describe("_bulk_docs", () => {
    const db = "activeledgerbulk";

    it("writes every document and answers ok", async () => {
      const r = await s.req("POST", `/${db}/_bulk_docs`, {
        docs: [
          { _id: "b1", v: 1 },
          { _id: "b2", v: 2 },
          { _id: "b3", v: 3 },
        ],
      });
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ ok: true });
      for (const [id, v] of [["b1", 1], ["b2", 2], ["b3", 3]] as const) {
        expect((await s.req("GET", `/${db}/${id}`)).json.v).to.equal(v);
      }
    });

    it("writes a single document", async () => {
      const r = await s.req("POST", `/${db}/_bulk_docs`, { docs: [{ _id: "solo", v: 1 }] });
      expect(r.json).to.deep.equal({ ok: true });
      expect((await s.req("GET", `/${db}/solo`)).json.v).to.equal(1);
    });

    it("honours the new_edits option, keeping a supplied revision", async () => {
      const r = await s.req("POST", `/${db}/_bulk_docs`, {
        docs: [{ _id: "kept", _rev: "7-abc", v: 1 }],
        options: { new_edits: false },
      });
      expect(r.json).to.deep.equal({ ok: true });
      expect((await s.req("GET", `/${db}/kept`)).json._rev).to.equal("7-abc");
    });

    it("a bulk write of the same id twice advances its revision", async () => {
      await s.req("POST", `/${db}/_bulk_docs`, { docs: [{ _id: "again", v: 1 }] });
      await s.req("POST", `/${db}/_bulk_docs`, { docs: [{ _id: "again", v: 2 }] });
      const got = await s.req("GET", `/${db}/again`);
      expect(got.json.v).to.equal(2);
      expect(got.json._rev.startsWith("2-")).to.equal(true);
    });
  });

  describe("_seq and _compact on a legacy rev-tree database", () => {
    // Older versions stored a root document pointing at by-sequence entries.
    // Those are seeded straight into the database before it is opened by the
    // server, since nothing over HTTP writes them any more.
    let legacy: Storage;
    const SEQ = "ÿby-sequenceÿ";
    const pad = (n: number) => String(n).padStart(16, "0");

    before(async () => {
      legacy = await startStorage(["level"], "ldata", async (prefix) => {
        const { LevelMe } = require("../packages/storage/src/levelme");
        const { LevelDBDriver } = require("../packages/storage/src/drivers/leveldb");
        const { ActiveClone } = require("../packages/utilities/src/clone");
        const lm = new LevelMe(prefix, "activeledger", "level", false);
        await lm.writeRaw("legacy1", {
          _id: "legacy1",
          winningRev: "2-bbb",
          rev_map: { "1-aaa": pad(1), "2-bbb": pad(2) },
          rev_tree: [{ pos: 1, ids: ["aaa", {}, []] }],
          seq: 2,
        });
        await lm.close();
        const driver = new LevelDBDriver(prefix + "activeledger", "level");
        await driver.open();
        const put = async (n: number, doc: unknown) =>
          driver.put(SEQ + pad(n), await ActiveClone.serialize(doc));
        await put(1, { _id: "legacy1", _rev: "1-aaa", v: "one" });
        await put(2, { _id: "legacy1", _rev: "2-bbb", v: "two" });
        await put(3, { _id: "legacy3", _rev: "1-ccc", v: "three" });
        await driver.close();
      });
    });

    after(async () => {
      await legacy?.stop();
      legacy?.cleanup();
    });

    it("resolves a legacy root document to its winning revision body", async () => {
      const r = await legacy.req("GET", "/activeledger/legacy1");
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ _id: "legacy1", _rev: "2-bbb", v: "two" });
    });

    it("_raw returns the legacy root document itself", async () => {
      const r = await legacy.req("GET", "/activeledger/_raw/legacy1");
      expect(r.status).to.equal(200);
      expect(r.json.winningRev).to.equal("2-bbb");
      expect(r.json.rev_map["1-aaa"]).to.equal(pad(1));
    });

    it("_raw with @revision returns that revision's sequence entry", async () => {
      const { ActiveClone } = require("../packages/utilities/src/clone");
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const http = require("http");
        http.get(
          { host: "127.0.0.1", port: legacy.port, path: "/activeledger/_raw/legacy1@1-aaa", agent: false },
          (res: any) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          }
        ).on("error", reject);
      });
      const doc = await ActiveClone.deserialize(raw);
      expect(doc).to.deep.include({ _rev: "1-aaa", v: "one" });
    });

    it("_raw with an @revision the root does not know fails", async () => {
      const r = await legacy.req("GET", "/activeledger/_raw/legacy1@9-zzz");
      expect(r.status).to.equal(500);
    });

    it("_seq returns a sequence entry and 500s when there is none", async () => {
      const { ActiveClone } = require("../packages/utilities/src/clone");
      const http = require("http");
      const fetchRaw = (p: string) =>
        new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
          http.get(
            { host: "127.0.0.1", port: legacy.port, path: p, agent: false },
            (res: any) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
              );
            }
          ).on("error", reject);
        });
      const hit = await fetchRaw(`/activeledger/_seq/${pad(3)}`);
      expect(hit.status).to.equal(200);
      expect(await ActiveClone.deserialize(hit.body)).to.deep.include({ _id: "legacy3" });
      const miss = await fetchRaw(`/activeledger/_seq/${pad(99)}`);
      expect(miss.status).to.equal(500);
    });

    it("_changes lists the sequence entries after `since`", async () => {
      const r = await legacy.req("GET", "/activeledger/_changes?since=1&limit=10");
      expect(r.status).to.equal(200);
      expect(r.json.results).to.deep.equal([
        { id: "legacy1", seq: 2, changes: [{ rev: "2-bbb" }] },
        { id: "legacy3", seq: 3, changes: [{ rev: "1-ccc" }] },
      ]);
      expect(r.json.last_seq).to.equal(0);
    });

    it("_changes defaults to five entries and honours limit", async () => {
      const all = await legacy.req("GET", "/activeledger/_changes?since=0");
      expect(all.json.results.map((x: any) => x.seq)).to.deep.equal([1, 2, 3]);
      const one = await legacy.req("GET", "/activeledger/_changes?since=0&limit=1");
      expect(one.json.results.map((x: any) => x.seq)).to.deep.equal([1]);
    });

    it("_changes treats a limit below 1 as 1", async () => {
      const r = await legacy.req("GET", "/activeledger/_changes?since=0&limit=0");
      expect(r.json.results.map((x: any) => x.seq)).to.deep.equal([1]);
    });

    it("_changes can run descending and include docs", async () => {
      const r = await legacy.req(
        "GET",
        "/activeledger/_changes?since=0&descending=true&include_docs=true&limit=2"
      );
      expect(r.json.results.map((x: any) => x.seq)).to.deep.equal([3, 2]);
      expect(r.json.results[0].doc).to.deep.include({ _id: "legacy3", v: "three" });
    });

    it("_changes with since=now answers empty straight away", async () => {
      const r = await legacy.req("GET", "/activeledger/_changes?since=now");
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ results: [], last_seq: 0 });
    });

    it("a longpoll with changes already pending answers at once and completes", async () => {
      const st = await openStream(legacy.port, "/activeledger/_changes?feed=longpoll&since=1&limit=10");
      expect(st.status).to.equal(200);
      expect(st.headers["content-type"]).to.equal("application/json");
      await st.until(() => st.ended());
      const parsed = JSON.parse(st.body());
      expect(parsed.results.map((x: any) => x.seq)).to.deep.equal([2, 3]);
    });

    it("_seq DELETE removes the entry", async () => {
      const del = await legacy.req("DELETE", `/activeledger/_seq/${pad(3)}`);
      expect(del.status).to.equal(200);
      expect(del.json).to.deep.equal({ success: "ok" });
      const after = await legacy.req("GET", "/activeledger/_changes?since=0&limit=10");
      expect(after.json.results.map((x: any) => x.seq)).to.deep.equal([1, 2]);
    });

    it("_compact is accepted and leaves the data readable", async () => {
      // The compaction route never gets a response body back (the driver
      // resolves undefined), so the request is abandoned after being sent.
      const http = require("http");
      await new Promise<void>((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port: legacy.port, path: "/activeledger/_compact", agent: false },
          () => resolve()
        );
        req.on("error", () => resolve());
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 500);
      });
      const r = await legacy.req("GET", "/activeledger/legacy1");
      expect(r.json.v).to.equal("two");
    });
  });
});
