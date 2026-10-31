import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EPIDChild, PIDHandler } from "../packages/activeledger/src/cli/pid";
import { StatsHandler } from "../packages/activeledger/src/cli/stats";

// The stats file is ".STATS" in the working directory (and the pid file is
// read from there too), so each test runs inside its own temporary directory.
// The mutable CommonJS module (not an import namespace) is patched, which is
// what the handler under test reads from.
const child: any = require("child_process");

describe("StatsHandler (activeledger --stats)", () => {
  const startDir = process.cwd();
  let tmpDir: string;
  let stats: StatsHandler;

  const onDisk = () => JSON.parse(fs.readFileSync(".STATS", "utf8"));
  const writeStats = (data: any) =>
    fs.writeFileSync(".STATS", JSON.stringify(data));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-stats-test-"));
    process.chdir(tmpDir);
    stats = new StatsHandler();
  });

  afterEach(() => {
    process.chdir(startDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates the stats and pid files when missing", async () => {
      const before = Date.now();
      await stats.init();
      const file = onDisk();
      expect(file.restarts).to.deep.equal({ all: 0, auto: 0 });
      expect(file.startTime).to.be.within(before, Date.now());
      expect(fs.existsSync(".PID")).to.equal(true);
    });

    it("keeps an existing stats file", async () => {
      writeStats({ restarts: { all: 4, auto: 1 }, startTime: 123 });
      await stats.init();
      expect(onDisk()).to.deep.equal({
        restarts: { all: 4, auto: 1 },
        startTime: 123,
      });
    });
  });

  describe("restart counting", () => {
    beforeEach(async () => {
      await stats.init();
    });

    it("counts an automatic restart and records when", async () => {
      const before = Date.now();
      await stats.updateRestartCount(true);
      await stats.updateRestartCount(true);
      const { restarts } = onDisk();
      expect(restarts.all).to.equal(2);
      expect(restarts.auto).to.equal(2);
      expect(new Date(restarts.lastAuto).getTime()).to.be.within(
        before,
        Date.now()
      );
      expect(restarts.lastManual).to.equal(undefined);
    });

    it("resets the auto counter on a manual restart but still counts it", async () => {
      await stats.updateRestartCount(true);
      await stats.updateRestartCount(true);
      const before = Date.now();
      await stats.updateRestartCount();
      const { restarts } = onDisk();
      expect(restarts.all).to.equal(3);
      expect(restarts.auto).to.equal(0);
      expect(restarts.lastAuto).to.equal(undefined);
      expect(new Date(restarts.lastManual).getTime()).to.be.within(
        before,
        Date.now()
      );
    });

    it("resets only the auto counter", async () => {
      await stats.updateRestartCount(true);
      await stats.resetAutoRestartCount();
      const { restarts } = onDisk();
      expect(restarts.all).to.equal(1);
      expect(restarts.auto).to.equal(0);
      expect(restarts.lastAuto).to.equal(undefined);
    });

    it("resets the uptime clock without touching restarts", async () => {
      writeStats({ restarts: { all: 2, auto: 1 }, startTime: 1000 });
      const before = Date.now();
      await stats.resetUptime();
      const file = onDisk();
      expect(file.startTime).to.be.within(before, Date.now());
      expect(file.restarts).to.deep.equal({ all: 2, auto: 1 });
    });

    it("does nothing, and does not throw, when the stats file is unreadable", async () => {
      fs.writeFileSync(".STATS", "{broken");
      await stats.updateRestartCount(true);
      await stats.resetAutoRestartCount();
      await stats.resetUptime();
      expect(fs.readFileSync(".STATS", "utf8")).to.equal("{broken");
    });
  });

  describe("getStats", () => {
    it("reports an alive node with its uptime, restarts and version", async () => {
      await stats.init("9.9.9");
      await new PIDHandler().addPid(EPIDChild.LEDGER, process.pid);
      writeStats({
        restarts: { all: 3, auto: 2 },
        startTime: Date.now() - 60000,
      });

      const result = await stats.getStats();
      expect(result.status).to.equal("alive");
      expect(result.uptime).to.be.within(60000, 70000);
      expect(result.restarts).to.deep.equal({ all: 3, auto: 2 });
      expect(result.version).to.equal("9.9.9");
    });

    it("reports a dead node with no uptime when the ledger is not running", async () => {
      await stats.init();
      writeStats({
        restarts: { all: 0, auto: 0 },
        startTime: Date.now() - 60000,
      });
      const result = await stats.getStats();
      expect(result.status).to.equal("dead");
      expect(result.uptime).to.equal(0);
      expect(result.version).to.equal("unset");
    });

    it("reports this machine's cpu and memory", async () => {
      await stats.init();
      const { cpu, ram } = await stats.getStats();
      expect(cpu.cores).to.equal(os.cpus().length);
      expect(cpu.one).to.be.a("number");
      expect(cpu.five).to.be.a("number");
      expect(cpu.fifteen).to.be.a("number");
      expect(ram.total).to.equal(os.totalmem());
      expect(ram.free).to.be.within(1, ram.total);
    });

    it("measures the folder it runs in and the disk", async () => {
      if (os.type() === "Windows_NT") return;
      await stats.init();
      fs.writeFileSync("filler", Buffer.alloc(256 * 1024));
      const { hdd } = await stats.getStats();
      // du -s in 1K blocks: at least the 256K file
      expect(hdd.activeledger).to.be.at.least(256);
      expect(hdd.diskSize).to.be.greaterThan(0);
      expect(hdd.diskUsed).to.be.greaterThan(0);
      expect(hdd.diskFree).to.be.at.least(0);
    });

    it("returns zeroed disk stats when the disk commands fail", async () => {
      await stats.init();
      const real = child.execSync;
      child.execSync = () => {
        throw new Error("no du");
      };
      try {
        const { hdd } = await stats.getStats();
        expect(hdd).to.deep.equal({
          activeledger: 0,
          diskSize: 0,
          diskFree: 0,
          diskUsed: 0,
        });
      } finally {
        child.execSync = real;
      }
    });

    it("throws when the stats file cannot be read", async () => {
      let thrown: any;
      try {
        await stats.getStats();
      } catch (e) {
        thrown = e;
      }
      expect(thrown.code).to.equal("ENOENT");
    });
  });
});
