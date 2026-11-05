import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The RocksDB driver. @nxtedition/rocksdb is a native module that is not
 * installed here (it cannot be loaded), so the driver is exercised against an
 * in-memory stand-in for RocksLevel that has the same abstract-level shape:
 * get() resolves undefined for a missing key, iterator().next() resolves an
 * [key, value] entry or undefined, status is "open" once opened.
 */

const Module = require("module");

class FakeRocksLevel {
  static instances: FakeRocksLevel[] = [];
  static openError: Error | null = null;
  static openDelay = 0;

  status = "opening";
  data = new Map<string, any>();
  batchCalls = 0;
  compacted: Array<[string, string]> = [];
  closedCount = 0;
  iterators: FakeIterator[] = [];

  constructor(public location: string, public options: any) {
    FakeRocksLevel.instances.push(this);
  }
  async open() {
    if (FakeRocksLevel.openDelay) {
      await new Promise((r) => setTimeout(r, FakeRocksLevel.openDelay));
    }
    if (FakeRocksLevel.openError) throw FakeRocksLevel.openError;
    this.status = "open";
  }
  async close() {
    this.closedCount++;
    this.status = "closed";
  }
  async get(key: string) {
    return this.data.get(key);
  }
  async getMany(keys: string[]) {
    return keys.map((k) => this.data.get(k));
  }
  async put(key: string, value: any) {
    this.data.set(key, value);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  batch() {
    this.batchCalls++;
    return { marker: "batch" };
  }
  iterator(options: any) {
    const it = new FakeIterator(
      [...this.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      options
    );
    this.iterators.push(it);
    return it;
  }
  values() {
    return { marker: "values" };
  }
  compactRange?: (a: string, b: string) => Promise<void> = async (a, b) => {
    this.compacted.push([a, b]);
  };
}

class FakeIterator {
  closed = 0;
  failWith: Error | null = null;
  constructor(public entries: Array<[string, any]>, public options: any) {}
  async next() {
    if (this.failWith) throw this.failWith;
    return this.entries.shift();
  }
  async close() {
    this.closed++;
  }
}

describe("RocksDBDriver (Activestorage)", () => {
  let tmp: string;
  let RocksDBDriver: any;
  let originalLoad: any;
  const driverPath = require.resolve("../packages/storage/src/drivers/rocksdb");

  before(() => {
    originalLoad = Module._load;
    Module._load = function (request: string, ...rest: any[]) {
      if (request === "@nxtedition/rocksdb") {
        return { RocksLevel: FakeRocksLevel };
      }
      return originalLoad.call(this, request, ...rest);
    };
    delete require.cache[driverPath];
    RocksDBDriver = require("../packages/storage/src/drivers/rocksdb").RocksDBDriver;
  });

  after(() => {
    Module._load = originalLoad;
    delete require.cache[driverPath];
  });

  beforeEach(() => {
    FakeRocksLevel.instances = [];
    FakeRocksLevel.openError = null;
    FakeRocksLevel.openDelay = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-rocks-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const make = async (open = true) => {
    const d = new RocksDBDriver(path.join(tmp, "a", "b"), "rocksdb");
    if (open) await d.open();
    return { d, db: () => FakeRocksLevel.instances[0] };
  };

  const collect = (stream: any): Promise<any[]> =>
    new Promise((resolve, reject) => {
      const out: any[] = [];
      stream.on("data", (x: any) => out.push(x));
      stream.on("end", () => resolve(out));
      stream.on("error", reject);
    });

  it("creates the database folder, including parents, on construction", async () => {
    await make(false);
    expect(fs.statSync(path.join(tmp, "a", "b")).isDirectory()).to.equal(true);
  });

  describe("open and close", () => {
    it("is not open until opened", async () => {
      const { d } = await make(false);
      expect(d.isOpen()).to.equal(false);
      expect(FakeRocksLevel.instances).to.have.length(0);
    });

    it("opens the location with binary values", async () => {
      const { d, db } = await make();
      expect(d.isOpen()).to.equal(true);
      expect(db().location).to.equal(path.join(tmp, "a", "b"));
      expect(db().options).to.deep.equal({ valueEncoding: "binary" });
    });

    it("opening twice opens the store once", async () => {
      const { d } = await make();
      await d.open();
      expect(FakeRocksLevel.instances).to.have.length(1);
      expect(d.isOpen()).to.equal(true);
    });

    it("concurrent opens share one open in flight", async () => {
      FakeRocksLevel.openDelay = 50;
      const { d } = await make(false);
      await Promise.all([d.open(), d.open(), d.open()]);
      expect(FakeRocksLevel.instances).to.have.length(1);
      expect(d.isOpen()).to.equal(true);
    });

    it("a failed open rethrows, leaves it closed, and can be retried", async () => {
      FakeRocksLevel.openError = new Error("LOCK held");
      const { d } = await make(false);
      let thrown: any;
      try {
        await d.open();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(thrown.message).to.equal("LOCK held");
      expect(d.isOpen()).to.equal(false);

      FakeRocksLevel.openError = null;
      await d.open();
      expect(d.isOpen()).to.equal(true);
      expect(FakeRocksLevel.instances).to.have.length(2);
    });

    it("close closes the store and it is no longer open", async () => {
      const { d, db } = await make();
      await d.close();
      expect(db().closedCount).to.equal(1);
      expect(d.isOpen()).to.equal(false);
    });

    it("can be reopened after a close with a fresh store", async () => {
      const { d } = await make();
      await d.close();
      await d.open();
      expect(d.isOpen()).to.equal(true);
      expect(FakeRocksLevel.instances).to.have.length(2);
    });
  });

  describe("reads and writes", () => {
    it("get returns what was put, as a Buffer", async () => {
      const { d } = await make();
      await d.put("k", Buffer.from("value"));
      const v = await d.get("k");
      expect(Buffer.isBuffer(v)).to.equal(true);
      expect(v.toString()).to.equal("value");
    });

    it("get converts a string value to a Buffer", async () => {
      const { d, db } = await make();
      db().data.set("s", "plain");
      const v = await d.get("s");
      expect(Buffer.isBuffer(v)).to.equal(true);
      expect(v.toString()).to.equal("plain");
    });

    it("get returns a Buffer value as the very same Buffer", async () => {
      const { d, db } = await make();
      const buf = Buffer.from("same");
      db().data.set("b", buf);
      expect(await d.get("b")).to.equal(buf);
    });

    it("get of a missing key rejects with a level style not found error", async () => {
      const { d } = await make();
      let err: any;
      try {
        await d.get("nope");
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err.notFound).to.equal(true);
      expect(err.code).to.equal("LEVEL_NOT_FOUND");
      expect(err.message).to.equal("Key not found in database [nope]");
    });

    it("get returns an empty value rather than treating it as missing", async () => {
      const { d, db } = await make();
      db().data.set("empty", Buffer.alloc(0));
      const v = await d.get("empty");
      expect(v.length).to.equal(0);
    });

    it("getOrUndefined resolves undefined for a missing key", async () => {
      const { d } = await make();
      expect(await d.getOrUndefined("nope")).to.equal(undefined);
    });

    it("getOrUndefined returns present values as Buffers", async () => {
      const { d, db } = await make();
      db().data.set("a", "text");
      db().data.set("b", Buffer.from("bin"));
      const a = await d.getOrUndefined("a");
      expect(Buffer.isBuffer(a)).to.equal(true);
      expect(a.toString()).to.equal("text");
      expect((await d.getOrUndefined("b")).toString()).to.equal("bin");
    });

    it("getMany omits missing keys and keeps the order of the rest", async () => {
      const { d, db } = await make();
      db().data.set("1", Buffer.from("one"));
      db().data.set("3", "three");
      const vals = await d.getMany(["1", "2", "3"]);
      expect(vals.map((v: Buffer) => v.toString())).to.deep.equal(["one", "three"]);
      expect(vals.every((v: any) => Buffer.isBuffer(v))).to.equal(true);
    });

    it("getMany of nothing is empty", async () => {
      const { d } = await make();
      expect(await d.getMany([])).to.deep.equal([]);
    });

    it("del removes a key", async () => {
      const { d } = await make();
      await d.put("x", Buffer.from("1"));
      await d.del("x");
      expect(await d.getOrUndefined("x")).to.equal(undefined);
    });
  });

  describe("batch", () => {
    it("returns the store's batch when open, without reopening", async () => {
      const { d, db } = await make();
      const b = await d.batch();
      expect(b).to.deep.equal({ marker: "batch" });
      expect(db().batchCalls).to.equal(1);
      expect(FakeRocksLevel.instances).to.have.length(1);
    });

    it("opens the store first if it is not open", async () => {
      const { d } = await make(false);
      const b = await d.batch();
      expect(b).to.deep.equal({ marker: "batch" });
      expect(d.isOpen()).to.equal(true);
    });

    it("reopens a closed store", async () => {
      const { d } = await make();
      await d.close();
      await d.batch();
      expect(d.isOpen()).to.equal(true);
      expect(FakeRocksLevel.instances).to.have.length(2);
    });
  });

  describe("streams", () => {
    it("createReadStream yields key and Buffer value for every entry, in order", async () => {
      const { d, db } = await make();
      db().data.set("b", "two");
      db().data.set("a", Buffer.from("one"));
      db().data.set("c", "three");
      const rows = await collect(d.createReadStream({ gt: "0" }));
      expect(rows.map((r: any) => r.key)).to.deep.equal(["a", "b", "c"]);
      expect(rows.map((r: any) => r.value.toString())).to.deep.equal(["one", "two", "three"]);
      expect(rows.every((r: any) => Buffer.isBuffer(r.value))).to.equal(true);
    });

    it("passes the options through to the iterator", async () => {
      const { d, db } = await make();
      const stream = d.createReadStream({ gt: "a", limit: 3 });
      await collect(stream);
      expect(db().iterators[0].options).to.deep.equal({ gt: "a", limit: 3 });
    });

    it("closes the iterator once the data runs out", async () => {
      const { d, db } = await make();
      db().data.set("a", "1");
      await collect(d.createReadStream({}));
      expect(db().iterators[0].closed).to.be.greaterThan(0);
    });

    it("an empty store gives an empty stream", async () => {
      const { d } = await make();
      expect(await collect(d.createReadStream({}))).to.deep.equal([]);
    });

    it("an iterator failure is emitted as a stream error", async () => {
      const { d, db } = await make();
      const stream = d.createReadStream({});
      db().iterators[0].failWith = new Error("disk gone");
      let err: any;
      try {
        await collect(stream);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err.message).to.equal("disk gone");
    });

    it("destroying the stream closes the iterator", async () => {
      const { d, db } = await make();
      db().data.set("a", "1");
      const stream = d.createReadStream({});
      await new Promise<void>((resolve) => {
        stream.on("close", () => resolve());
        stream.destroy();
      });
      expect(db().iterators[0].closed).to.be.greaterThan(0);
    });

    it("createValueStream is the store's values stream", async () => {
      const { d } = await make();
      expect(d.createValueStream()).to.deep.equal({ marker: "values" });
    });
  });

  describe("compactRange", () => {
    it("passes the range to the store", async () => {
      const { d, db } = await make();
      await d.compactRange("a", "z");
      expect(db().compacted).to.deep.equal([["a", "z"]]);
    });

    it("does nothing when the store cannot compact", async () => {
      const { d, db } = await make();
      db().compactRange = undefined;
      await d.compactRange("a", "z");
      expect(db().compacted).to.deep.equal([]);
    });
  });
});
