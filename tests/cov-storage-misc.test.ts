import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LevelMe } from "../packages/storage/src/levelme";
import { LevelDBDriver } from "../packages/storage/src/drivers/leveldb";
import { openEmbeddedStorage } from "../packages/storage/src/embedded";

const collect = (stream: any): Promise<any[]> =>
  new Promise((resolve, reject) => {
    const out: any[] = [];
    stream.on("data", (d: any) => out.push(d));
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });

describe("Storage package surface", () => {
  it("exports the data store, embedded storage and the event helpers", () => {
    const api = require("../packages/storage/src/index");
    expect(api.ActiveDataStore).to.be.a("function");
    expect(api.EmbeddedDSConnect).to.be.a("function");
    expect(api.openEmbeddedStorage).to.be.a("function");
    expect(api.eventsSince).to.be.a("function");
    expect(api.EVENT_PREFIX).to.equal("event:");
  });

  it("the driver interface module loads", () => {
    expect(() => require("../packages/storage/src/driver")).to.not.throw();
  });
});

describe("ActiveDataStore pid file", () => {
  const startDir = process.cwd();
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-storage-pid-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(startDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = () => {
    const { ActiveDataStore } = require("../packages/storage/src/datastore");
    return Object.create(ActiveDataStore.prototype);
  };

  it("records the storage pid in an existing .PID file, keeping the other entries", async () => {
    fs.writeFileSync(".PID", JSON.stringify({ activeledger: 11, activerestore: 12 }));
    await store().storePid(4242);
    expect(JSON.parse(fs.readFileSync(".PID", "utf8"))).to.deep.equal({
      activeledger: 11,
      activerestore: 12,
      activestorage: 4242,
    });
  });

  it("without a .PID file it only warns and creates nothing", async () => {
    await store().storePid(4242);
    expect(fs.existsSync(".PID")).to.equal(false);
  });

  it("with a .PID file that is not json it leaves the file alone", async () => {
    fs.writeFileSync(".PID", "not json");
    await store().storePid(4242);
    expect(fs.readFileSync(".PID", "utf8")).to.equal("not json");
  });
});

describe("Storage error paths", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-storage-misc-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("embedded storage answering a write that fails", () => {
    it("post() of something that is not a document resolves a reason, not a rejection", async () => {
      const storage = await openEmbeddedStorage(tmp);
      try {
        const r = await storage.data.post("not a document" as any);
        expect(r).to.have.property("reason").that.is.a("string").and.is.not.empty;
        expect(r).to.not.have.property("ok");
      } finally {
        await storage.close();
      }
    });

    it("put() of something that is not a document resolves a reason, not a rejection", async () => {
      const storage = await openEmbeddedStorage(tmp);
      try {
        const r = await storage.data.put("not a document" as any);
        expect(r).to.have.property("reason").that.is.a("string").and.is.not.empty;
        expect(r).to.not.have.property("ok");
      } finally {
        await storage.close();
      }
    });
  });

  describe("LevelDBDriver streams over a closed database", () => {
    it("createReadStream emits the error and ends", async () => {
      const driver = new LevelDBDriver(path.join(tmp, "db"), "level");
      await driver.open();
      await driver.put("a", Buffer.from("1"));
      const stream = driver.createReadStream({});
      await driver.close();
      let err: any;
      try {
        await collect(stream);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
    });

    it("createValueStream emits the error and ends", async () => {
      const driver = new LevelDBDriver(path.join(tmp, "db"), "level");
      await driver.open();
      await driver.put("a", Buffer.from("1"));
      const stream = driver.createValueStream();
      await driver.close();
      let err: any;
      try {
        await collect(stream);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
    });

    it("createValueStream yields every value as a Buffer", async () => {
      const driver = new LevelDBDriver(path.join(tmp, "db"), "level");
      await driver.open();
      await driver.put("a", Buffer.from("1"));
      await driver.put("b", Buffer.from("2"));
      const vals = await collect(driver.createValueStream());
      expect(vals.map((v) => v.toString())).to.deep.equal(["1", "2"]);
      await driver.close();
    });
  });

  describe("LevelMe", () => {
    const open = () => new LevelMe(tmp + path.sep, "activeledgermisc", "level", false);

    it("a change listener that throws does not fail post()", async () => {
      const db = open();
      try {
        const seen: string[] = [];
        db.changes().on("change", (c: any) => seen.push(c.id));
        db.changes().on("change", () => {
          throw new Error("listener bug");
        });
        const r: any = await db.post({ _id: "p1", v: 1 });
        expect(r.ok).to.equal(true);
        expect(r.id).to.equal("p1");
        expect((await db.get("p1") as any).v).to.equal(1);
        expect(seen).to.deep.equal(["p1"]);
      } finally {
        db.changes().removeAllListeners("change");
        await db.close();
      }
    });

    it("a change listener that throws does not fail bulkDocs() or hide the other documents' changes", async () => {
      const db = open();
      try {
        const seen: string[] = [];
        db.changes().on("change", (c: any) => seen.push(c.id));
        db.changes().on("change", () => {
          throw new Error("listener bug");
        });
        const ok = await db.bulkDocs([{ _id: "b1" }, { _id: "b2" }] as any, { new_edits: true });
        expect(ok).to.equal(true);
        expect(seen.sort()).to.deep.equal(["b1", "b2"]);
      } finally {
        db.changes().removeAllListeners("change");
        await db.close();
      }
    });

    it("listeners after one that throws still run, in registration order, for post() and bulkDocs()", async () => {
      const db = open();
      try {
        const order: string[] = [];
        db.changes().on("change", (c: any) => order.push(`first:${c.id}`));
        db.changes().on("change", () => {
          throw new Error("listener bug");
        });
        db.changes().on("change", (c: any) => order.push(`third:${c.id}`));
        await db.post({ _id: "o1", v: 1 });
        expect(order).to.deep.equal(["first:o1", "third:o1"]);
        order.length = 0;
        expect(await db.bulkDocs([{ _id: "o2" }] as any, { new_edits: true })).to.equal(true);
        expect(order).to.deep.equal(["first:o2", "third:o2"]);
      } finally {
        db.changes().removeAllListeners("change");
        await db.close();
      }
    });

    it("a once listener fires once, even after an earlier listener threw", async () => {
      const db = open();
      try {
        const seen: string[] = [];
        db.changes().on("change", () => {
          throw new Error("listener bug");
        });
        db.changes().once("change", (c: any) => seen.push(c.id));
        await db.post({ _id: "n1", v: 1 });
        await db.post({ _id: "n2", v: 1 });
        expect(seen).to.deep.equal(["n1"]);
        expect(db.changes().listenerCount("change")).to.equal(1);
      } finally {
        db.changes().removeAllListeners("change");
        await db.close();
      }
    });

    it("allDocs rejects when the keys cannot be read", async () => {
      const db = open();
      try {
        let err: unknown;
        try {
          await db.allDocs({ keys: 5 } as any);
        } catch (e) {
          err = e;
        }
        expect(err).to.not.equal(undefined);
      } finally {
        await db.close();
      }
    });

    it("restore() reads a last line that has no trailing newline", async () => {
      const file = path.join(tmp, "nonl.alb");
      fs.writeFileSync(
        file,
        JSON.stringify({ _id: "n1", v: 1 }) + "\n" + JSON.stringify({ _id: "n2", v: 2 })
      );
      const db = open();
      try {
        await db.restore(file);
        expect((await db.get("n1") as any).v).to.equal(1);
        expect((await db.get("n2") as any).v).to.equal(2);
        expect(fs.existsSync(file + ".status")).to.equal(false);
      } finally {
        await db.close();
      }
    });

    it("restore() rejects when its status file disappears mid way", async () => {
      const file = path.join(tmp, "gone.alb");
      fs.writeFileSync(file, JSON.stringify({ _id: "g1", v: 1 }) + "\n");
      const db = open();
      try {
        const done = db.restore(file);
        // the status file is written first; remove it before the read ends
        const deadline = Date.now() + 2000;
        while (!fs.existsSync(file + ".status") && Date.now() < deadline) {
          await new Promise((r) => setImmediate(r));
        }
        fs.rmSync(file + ".status", { force: true });
        let err: any;
        try {
          await done;
        } catch (e) {
          err = e;
        }
        expect(err).to.not.equal(undefined);
        expect(err.code).to.equal("ENOENT");
      } finally {
        await db.close();
      }
    });
  });
});
