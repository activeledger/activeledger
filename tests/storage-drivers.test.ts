import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { ActiveOptions } from "@activeledger/activeoptions";
import { LevelDBDriver } from "../packages/storage/src/drivers/leveldb";
import { ActiveDataStore } from "../packages/storage/src/datastore";

// The mutable CommonJS module (not an import namespace) is patched, which is
// what the data store under test reads from.
const cp: any = require("child_process");

const collect = (stream: any): Promise<any[]> =>
  new Promise((resolve, reject) => {
    const out: any[] = [];
    stream.on("data", (d: any) => out.push(d));
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });

// The leveldb driver is run against a real on disk database in a temporary
// folder (it is an embedded library, no server is involved).
describe("LevelDBDriver (Activestorage)", () => {
  let tmpDir: string;
  let location: string;
  let driver: LevelDBDriver;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-leveldb-"));
    location = path.join(tmpDir, "nested", "db");
    driver = new LevelDBDriver(location, "level");
  });

  afterEach(async () => {
    if (driver.isOpen()) await driver.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the database folder, including parents, on construction", () => {
    expect(fs.statSync(location).isDirectory()).to.equal(true);
  });

  it("is not open until opened, and open once opened", async () => {
    expect(driver.isOpen()).to.equal(false);
    await driver.open();
    expect(driver.isOpen()).to.equal(true);
    await driver.close();
    expect(driver.isOpen()).to.equal(false);
  });

  it("opening twice is harmless", async () => {
    await driver.open();
    await driver.open();
    expect(driver.isOpen()).to.equal(true);
  });

  it("returns what was put as a Buffer", async () => {
    await driver.open();
    await driver.put("k", JSON.stringify({ a: 1 }));
    const v = await driver.get("k");
    expect(Buffer.isBuffer(v)).to.equal(true);
    expect(JSON.parse(v.toString())).to.deep.equal({ a: 1 });
  });

  it("throws a not found error for a missing key", async () => {
    await driver.open();
    let thrown: any;
    try {
      await driver.get("nope");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.an("error");
    expect(thrown.notFound).to.equal(true);
    expect(thrown.code).to.equal("LEVEL_NOT_FOUND");
    expect(thrown.message).to.contain("nope");
  });

  it("deletes a key", async () => {
    await driver.open();
    await driver.put("k", "v");
    await driver.del("k");
    let thrown: any;
    try {
      await driver.get("k");
    } catch (e) {
      thrown = e;
    }
    expect(thrown.notFound).to.equal(true);
  });

  it("keeps data across a close and reopen", async () => {
    await driver.open();
    await driver.put("k", "persisted");
    await driver.close();
    const again = new LevelDBDriver(location, "level");
    await again.open();
    try {
      expect((await again.get("k")).toString()).to.equal("persisted");
    } finally {
      await again.close();
    }
  });

  it("getMany leaves out missing keys rather than failing or padding", async () => {
    await driver.open();
    await driver.put("a", "1");
    await driver.put("c", "3");
    const found = await driver.getMany(["a", "b", "c"]);
    expect(found.map((b) => b.toString())).to.deep.equal(["1", "3"]);
  });

  it("applies batched writes together", async () => {
    await driver.open();
    await driver.put("old", "x");
    const batch: any = await driver.batch();
    batch.put("a", "1").put("b", "2").del("old");
    await batch.write();
    expect((await driver.get("a")).toString()).to.equal("1");
    expect((await driver.get("b")).toString()).to.equal("2");
    let thrown: any;
    try {
      await driver.get("old");
    } catch (e) {
      thrown = e;
    }
    expect(thrown.notFound).to.equal(true);
  });

  it("opens itself when a batch is asked for on a closed database", async () => {
    const batch: any = await driver.batch();
    batch.put("k", "v");
    await batch.write();
    expect(driver.isOpen()).to.equal(true);
    expect((await driver.get("k")).toString()).to.equal("v");
  });

  it("streams keys and values in key order, honouring range options", async () => {
    await driver.open();
    for (const k of ["a", "b", "c", "d"]) await driver.put(k, "v-" + k);
    const all = await collect(driver.createReadStream({}));
    expect(all.map((e) => [e.key, e.value.toString()])).to.deep.equal([
      ["a", "v-a"],
      ["b", "v-b"],
      ["c", "v-c"],
      ["d", "v-d"],
    ]);
    expect(all[0].value).to.be.instanceOf(Buffer);

    const range = await collect(driver.createReadStream({ gte: "b", lt: "d" }));
    expect(range.map((e) => e.key)).to.deep.equal(["b", "c"]);

    const reversed = await collect(
      driver.createReadStream({ reverse: true, limit: 2 })
    );
    expect(reversed.map((e) => e.key)).to.deep.equal(["d", "c"]);
  });

  it("streams values as Buffers in key order", async () => {
    await driver.open();
    await driver.put("b", "2");
    await driver.put("a", "1");
    const values = await collect(driver.createValueStream());
    expect(values.every((v) => Buffer.isBuffer(v))).to.equal(true);
    expect(values.map((v) => v.toString())).to.deep.equal(["1", "2"]);
  });

  it("streams nothing from an empty database", async () => {
    await driver.open();
    expect(await collect(driver.createReadStream({}))).to.deep.equal([]);
    expect(await collect(driver.createValueStream())).to.deep.equal([]);
  });

  it("compacts a range without losing data", async () => {
    await driver.open();
    await driver.put("a", "1");
    await driver.compactRange("a", "z");
    expect((await driver.get("a")).toString()).to.equal("1");
  });

  it("clears its half open state when opening fails, so it can open later", async () => {
    // A file where the database folder should be makes the open fail
    const blocked = path.join(tmpDir, "blocked");
    const failing = new LevelDBDriver(blocked, "level");
    fs.rmSync(blocked, { recursive: true });
    fs.writeFileSync(blocked, "not a folder");
    let thrown: any;
    try {
      await failing.open();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.an("error");
    expect(failing.isOpen()).to.equal(false);

    fs.rmSync(blocked);
    fs.mkdirSync(blocked);
    await failing.open();
    expect(failing.isOpen()).to.equal(true);
    await failing.close();
  });
});

// ActiveDataStore starts the self hosted storage process. spawn is replaced
// by a fake process so nothing is launched; the folder and pid file it
// touches are real, in a temporary working directory.
describe("ActiveDataStore (Activestorage)", () => {
  const startDir = process.cwd();
  const realSpawn = cp.spawn;
  const config = ActiveOptions.fetch(false);
  let savedDb: any;
  let tmpDir: string;
  let spawned: { cmd: string; args: string[]; opts: any; proc: any }[];
  let nextPid: number;

  const setDb = (selfhost: any) => (config.db = { selfhost });

  // storePid is not awaited by launch(), so wait for it to land
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-ds-"));
    process.chdir(tmpDir);
    savedDb = config.db;
    spawned = [];
    nextPid = 4000;
    cp.spawn = (cmd: string, args: string[], opts: any) => {
      const proc: any = new EventEmitter();
      proc.pid = nextPid++;
      spawned.push({ cmd, args, opts, proc });
      return proc;
    };
  });

  afterEach(() => {
    cp.spawn = realSpawn;
    process.chdir(startDir);
    if (savedDb === undefined) delete config.db;
    else config.db = savedDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the configured data folder", () => {
    setDb({ dir: "my-ds", port: 5984 });
    new ActiveDataStore();
    expect(fs.statSync("my-ds").isDirectory()).to.equal(true);
  });

  it("defaults the data folder to .ds", () => {
    setDb({ port: 5984 });
    new ActiveDataStore();
    expect(fs.statSync(".ds").isDirectory()).to.equal(true);
  });

  it("launches selfhost.js with folder, port, engine and host, and returns its url", () => {
    setDb({ dir: "d", port: 5984, engine: "rocksdb", host: "10.0.0.5" });
    const url = new ActiveDataStore().launch();
    expect(url).to.equal("http://127.0.0.1:5984");
    expect(spawned).to.have.length(1);
    expect(spawned[0].cmd).to.equal("node");
    expect(path.basename(spawned[0].args[0])).to.equal("selfhost.js");
    expect(spawned[0].args.slice(1)).to.deep.equal([
      "d",
      "5984",
      "rocksdb",
      "10.0.0.5",
    ]);
    expect(spawned[0].opts).to.deep.equal({ stdio: "inherit" });
  });

  it("defaults the engine to level and binds to loopback", () => {
    setDb({ dir: "d", port: 5985 });
    new ActiveDataStore().launch();
    expect(spawned[0].args.slice(1)).to.deep.equal([
      "d",
      "5985",
      "level",
      "127.0.0.1",
    ]);
  });

  it("records the process id in the pid file for --stop", async () => {
    setDb({ dir: "d", port: 5984 });
    fs.writeFileSync(
      ".PID",
      JSON.stringify({ activeledger: 1, activestorage: 0, activerestore: 2 })
    );
    new ActiveDataStore().launch();
    const stored = () => JSON.parse(fs.readFileSync(".PID", "utf8"));
    await until(() => stored().activestorage === 4000);
    expect(stored()).to.deep.equal({
      activeledger: 1,
      activestorage: 4000,
      activerestore: 2,
    });
  });

  it("carries on without a pid file", async () => {
    setDb({ dir: "d", port: 5984 });
    new ActiveDataStore().launch();
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(".PID")).to.equal(false);
    expect(spawned).to.have.length(1);
  });

  it("starts it again when it dies unexpectedly", () => {
    setDb({ dir: "d", port: 5984 });
    new ActiveDataStore().launch();
    spawned[0].proc.emit("exit", 1, null);
    expect(spawned).to.have.length(2);
    expect(spawned[1].args).to.deep.equal(spawned[0].args);
    // The replacement is watched too
    spawned[1].proc.emit("exit", 1, null);
    expect(spawned).to.have.length(3);
  });

  it("does not restart after SIGTERM", () => {
    setDb({ dir: "d", port: 5984 });
    new ActiveDataStore().launch();
    spawned[0].proc.emit("exit", null, "SIGTERM");
    expect(spawned).to.have.length(1);
  });

  it("does not restart when shutting down", () => {
    setDb({ dir: "d", port: 5984 });
    const ds = new ActiveDataStore();
    ds.launch();
    ds.isShuttingDown = true;
    spawned[0].proc.emit("exit", 0, null);
    expect(spawned).to.have.length(1);
  });

  describe("restart limit", () => {
    const realNow = Date.now;
    let now: number;

    beforeEach(() => {
      now = realNow();
      Date.now = () => now;
    });

    afterEach(() => {
      Date.now = realNow;
    });

    // Kill the newest process until no replacement is started
    const dieUntilRefused = () => {
      let restarts = 0;
      for (;;) {
        const before = spawned.length;
        spawned[before - 1].proc.emit("exit", 1, null);
        if (spawned.length === before) return restarts;
        restarts++;
      }
    };

    it("allows exactly five restarts, then refuses", () => {
      setDb({ dir: "d", port: 5984 });
      new ActiveDataStore().launch();
      expect(dieUntilRefused()).to.equal(5);
      expect(spawned).to.have.length(6);
    });

    it("allows restarts again 24 hours after the last one", () => {
      setDb({ dir: "d", port: 5984 });
      new ActiveDataStore().launch();
      expect(dieUntilRefused()).to.equal(5);
      // Just short of a day since the last restart: still refused
      now += 23 * 60 * 60 * 1000;
      expect(dieUntilRefused()).to.equal(0);
      // Past a day since the last restart: the counter starts again
      now += 2 * 60 * 60 * 1000;
      expect(dieUntilRefused()).to.equal(5);
    });
  });

  it("gives up restarting a process that keeps dying", () => {
    setDb({ dir: "d", port: 5984 });
    new ActiveDataStore().launch();
    for (let i = 0; i < 20 && i < spawned.length; i++) {
      spawned[i].proc.emit("exit", 1, null);
    }
    // Bounded, not an endless restart loop
    expect(spawned.length).to.be.greaterThan(2);
    expect(spawned.length).to.be.lessThan(20);
  });
});
