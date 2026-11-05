import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDataStore } from "@activeledger/activestorage";
import { ActiveNetwork, ActiveInterfaces } from "@activeledger/activenetwork";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveRequest,
} from "@activeledger/activeoptions";
import { CLIHandler } from "../packages/activeledger/src/cli/cli";
import { EPIDChild } from "../packages/activeledger/src/cli/pid";
import { TestnetHandler } from "../packages/activeledger/src/cli/testnet";
import { Startup } from "../packages/activeledger/src/cli/startup";

// In-process tests of CLIHandler with the process-level side effects
// (exit, kill, spawn, network, logging) replaced by recorders. Every test
// runs in its own scratch directory because the CLI reads and writes
// .PID, .STATS, config.json and .identity relative to the working directory.

const nodeFs: any = require("fs");
const nodeChild: any = require("child_process");
const C: any = CLIHandler;
const O: any = ActiveOptions;

class ExitSignal extends Error {
  constructor(public code?: number) {
    super(`exit(${code})`);
  }
}

type Log = { level: string; args: any[] };

describe("CLIHandler (in-process)", () => {
  const startDir = process.cwd();
  let tmp: string;
  let logs: Log[];
  let restores: (() => void)[];
  let identity: any;

  const patch = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => {
      if (had) obj[key] = orig;
      else delete obj[key];
    });
  };
  const messages = (level: string) =>
    logs
      .filter((l) => l.level === level)
      .map((l) => l.args.filter((a) => typeof a === "string").join(" "));
  const setOptions = (argv: any, config: any = {}) => {
    O.argv = { _: [], ...argv };
    O.config = config;
  };
  const writeIdentity = () =>
    fs.writeFileSync(".identity", JSON.stringify(identity));
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

  before(() => {
    identity = new ActiveCrypto.KeyPair("rsa").generate();
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-cli-"));
    process.chdir(tmp);
    logs = [];
    restores = [];
    const savedArgv = O.argv;
    const savedConfig = O.config;
    const savedVersion = ActiveOptions.configVersion;
    restores.push(() => {
      O.argv = savedArgv;
      O.config = savedConfig;
      ActiveOptions.configVersion = savedVersion;
    });
    for (const level of ["info", "warn", "error", "fatal", "debug"]) {
      patch(ActiveLogger, level, (...args: any[]) => {
        logs.push({ level, args });
        return new Error("fatal");
      });
    }
    patch(process, "exit", (code?: number) => {
      throw new ExitSignal(code);
    });
    // Start-up display is cosmetic: record what it was told instead
    for (const m of ["init", "begin", "done", "fail", "finish"]) {
      patch(Startup, m, (...args: any[]) => {
        logs.push({ level: `startup.${m}`, args });
      });
    }
    setOptions({});
  });

  afterEach(async () => {
    // stop() does not wait for resetPidFile(), so its write to .PID can still be
    // in flight when a test returns. Let it land in this test's temp directory
    // before the next test writes its own .PID there (otherwise a late reset
    // overwrites it with zeros, which showed up only under slow coverage I/O).
    // (Restore first: one test fakes setTimeout, and this wait must use the real one.)
    while (restores.length) restores.pop()!();
    await new Promise((r) => setTimeout(r, 100));
    process.chdir(startDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("stop", () => {
    const writePids = (p: any) => fs.writeFileSync(".PID", JSON.stringify(p));
    const killRecorder = (failWith?: Record<number, string>) => {
      const killed: number[] = [];
      patch(process, "kill", (pid: number) => {
        killed.push(pid);
        if (failWith && failWith[pid]) {
          const e: any = new Error("kill");
          e.code = failWith[pid];
          throw e;
        }
        return true;
      });
      return killed;
    };

    it("kills every recorded child, including a leftover ActiveCore, and resets the pid file", async () => {
      writePids({
        activeledger: 101,
        activestorage: 102,
        activerestore: 103,
        activecore: 104,
      });
      const killed = killRecorder();
      await CLIHandler.stop(true);
      expect(killed).to.deep.equal([101, 102, 104, 103]);
      expect(messages("warn")).to.deep.equal([]);
      expect(messages("info")).to.include(
        "Shutdown complete, reseting PID file"
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(readJson(".PID")).to.deep.equal({
        activeledger: 0,
        activestorage: 0,
        activerestore: 0,
      });
    });

    it("warns instead of killing for a child with no pid", async () => {
      writePids({ activeledger: 0, activestorage: 0, activerestore: 0 });
      const killed = killRecorder();
      await CLIHandler.stop(true);
      expect(killed).to.deep.equal([]);
      expect(messages("warn")).to.deep.equal([
        "No PID for Activeledger process",
        "No PID for Activestorage process",
        "No PID for Activerestore process",
      ]);
    });

    it("carries on stopping the others when a process has already gone (ESRCH)", async () => {
      writePids({ activeledger: 5, activestorage: 6, activerestore: 7 });
      const killed = killRecorder({ 5: "ESRCH" });
      await CLIHandler.stop(true);
      expect(killed).to.deep.equal([5, 6, 7]);
      expect(messages("error")).to.deep.equal([]);
    });

    it("tolerates a missing ActiveCore process", async () => {
      writePids({
        activeledger: 5,
        activestorage: 6,
        activerestore: 7,
        activecore: 8,
      });
      const killed = killRecorder({ 8: "ESRCH" });
      await CLIHandler.stop(true);
      expect(killed).to.deep.equal([5, 6, 8, 7]);
      expect(messages("error")).to.deep.equal([]);
    });

    it("reports any other kill failure and does not reset the pid file", async () => {
      writePids({ activeledger: 5, activestorage: 6, activerestore: 7 });
      const killed = killRecorder({ 5: "EPERM" });
      await CLIHandler.stop(true);
      expect(killed).to.deep.equal([5]);
      expect(messages("error")).to.include("Error stopping activeledger");
      expect(messages("info")).to.not.include(
        "Shutdown complete, reseting PID file"
      );
      expect(readJson(".PID").activestorage).to.equal(6);
    });

    it("clears the auto restart count on a plain stop but not on a restart's stop", async () => {
      writePids({ activeledger: 0, activestorage: 0, activerestore: 0 });
      const stats = {
        restarts: { all: 4, auto: 3, lastAuto: "2020-01-01T00:00:00.000Z" },
        startTime: 1,
      };
      fs.writeFileSync(".STATS", JSON.stringify(stats));
      await CLIHandler.stop(true);
      expect(readJson(".STATS").restarts.auto).to.equal(3);
      await CLIHandler.stop();
      const after = readJson(".STATS").restarts;
      expect(after.auto).to.equal(0);
      expect(after.all).to.equal(4);
      expect(after.lastAuto).to.equal(undefined);
    });

    it("reports a failure to reset the pid file without throwing", async () => {
      writePids({ activeledger: 0, activestorage: 0, activerestore: 0 });
      patch(C.pidHandler, "resetPidFile", () => {
        throw new Error("disk");
      });
      await CLIHandler.stop(true);
      expect(messages("error")).to.include("Error reseting PID file");
    });
  });

  describe("restart", () => {
    it("stops (marking it a restart), starts with the version, then counts the restart", async () => {
      const calls: any[] = [];
      patch(CLIHandler, "stop", async (isRestart?: boolean) => {
        calls.push(["stop", isRestart]);
      });
      patch(CLIHandler, "start", async (v: string) => {
        calls.push(["start", v]);
      });
      patch(C.statsHandler, "updateRestartCount", async (auto?: boolean) => {
        calls.push(["count", auto]);
      });
      await CLIHandler.restart(true, "9.9.9");
      expect(calls).to.deep.equal([
        ["stop", true],
        ["start", "9.9.9"],
        ["count", true],
      ]);
      expect(messages("info")).to.deep.equal(["Restarting", "Restart complete"]);
    });

    it("keeps the version already set when none is passed", async () => {
      C.version = "1.2.3";
      const started: any[] = [];
      patch(CLIHandler, "stop", async () => undefined);
      patch(CLIHandler, "start", async (v: string) => {
        started.push(v);
      });
      patch(C.statsHandler, "updateRestartCount", async () => undefined);
      await CLIHandler.restart();
      expect(started).to.deep.equal(["1.2.3"]);
    });
  });

  describe("getStats / setupTestnet", () => {
    it("prints the stats as indented JSON", async () => {
      await CLIHandler.getStats("7.7.7");
      expect(C.version).to.equal("7.7.7");
      const infos = logs.filter((l) => l.level === "info");
      const printed = infos[infos.length - 1].args[0];
      const parsed = JSON.parse(printed);
      expect(parsed).to.be.an("object");
      expect(printed).to.contain("\n    ");
    });
  });

  describe("setupTestnet", () => {
    it("hands over to the testnet handler", () => {
      let called = 0;
      patch(TestnetHandler, "setup", () => called++);
      CLIHandler.setupTestnet();
      expect(called).to.equal(1);
    });
  });

  describe("start", () => {
    const stubStartup = () => {
      const seen: any[] = [];
      patch(C, "normalStart", () => seen.push("normalStart"));
      patch(C.pidHandler, "init", async () => seen.push("pid.init"));
      patch(C.pidHandler, "addPid", async (c: any, pid: number) =>
        seen.push(["addPid", c, pid])
      );
      patch(C.statsHandler, "init", () => seen.push("stats.init"));
      patch(C.statsHandler, "resetUptime", async () => seen.push("uptime"));
      return seen;
    };
    const signalCounts = () =>
      ["SIGINT", "SIGTERM", "SIGQUIT"].map((s) =>
        process.listeners(s as any).filter((l) => l === C.earlyShutdown).length
      );

    afterEach(() => {
      for (const s of C.earlySignals) process.off(s, C.earlyShutdown);
    });

    it("records its own pid, resets uptime and listens for an early stop", async () => {
      setOptions({});
      const seen = stubStartup();
      await CLIHandler.start("5.0.0");
      expect(C.version).to.equal("5.0.0");
      expect(seen).to.deep.equal([
        "stats.init",
        "pid.init",
        ["addPid", EPIDChild.LEDGER, process.pid],
        "uptime",
        "normalStart",
      ]);
      expect(signalCounts()).to.deep.equal([1, 1, 1]);
    });

    for (const flag of ["assert", "assert-network", "sign", "public", "setup-only"]) {
      it(`does not record a pid for the one-shot --${flag}`, async () => {
        setOptions({ [flag]: true });
        const seen = stubStartup();
        await CLIHandler.start("5.0.0");
        expect(seen).to.deep.equal(["stats.init", "pid.init", "normalStart"]);
        expect(signalCounts()).to.deep.equal([0, 0, 0]);
      });
    }
  });

  describe("earlyShutdown", () => {
    it("stops the storage and restore children, then exits 0", async () => {
      fs.writeFileSync(
        ".PID",
        JSON.stringify({ activeledger: 1, activestorage: 22, activerestore: 33 })
      );
      const killed: number[] = [];
      patch(process, "kill", (pid: number) => {
        killed.push(pid);
        if (pid === 22) throw new Error("gone");
      });
      let code: any = "none";
      try {
        await C.earlyShutdown();
      } catch (e: any) {
        code = e.code;
      }
      expect(killed).to.deep.equal([22, 33]);
      expect(code).to.equal(0);
    });

    it("skips children with no pid", async () => {
      fs.writeFileSync(
        ".PID",
        JSON.stringify({ activeledger: 0, activestorage: 0, activerestore: 0 })
      );
      const killed: number[] = [];
      patch(process, "kill", (pid: number) => killed.push(pid));
      try {
        await C.earlyShutdown();
      } catch (e: any) {
        expect(e.code).to.equal(0);
      }
      expect(killed).to.deep.equal([]);
    });

    it("still exits 0 when there is no pid file to read", async () => {
      patch(process, "kill", () => {
        throw new Error("must not kill");
      });
      let code: any = "none";
      try {
        await C.earlyShutdown();
      } catch (e: any) {
        code = e.code;
      }
      expect(code).to.equal(0);
    });
  });

  describe("terminate", () => {
    afterEach(() => {
      C.isShuttingDown = false;
    });

    it("shuts the host down once, flags the datastore and removes the children on exit", async () => {
      fs.writeFileSync(
        ".PID",
        JSON.stringify({ activeledger: 1, activestorage: 40, activerestore: 0 })
      );
      C.isShuttingDown = false;
      let shutdowns = 0;
      const host: any = { shutdown: () => shutdowns++ };
      const ds: any = { isShuttingDown: false };
      const killed: number[] = [];
      patch(process, "kill", (pid: number) => {
        killed.push(pid);
        throw new Error("already gone");
      });
      const exitListeners: Function[] = [];
      patch(process, "once", (ev: string, fn: Function) => {
        if (ev === "exit") exitListeners.push(fn);
        return process;
      });
      C.terminate(host, ds);
      await new Promise((r) => setTimeout(r, 50));
      expect(shutdowns).to.equal(1);
      expect(ds.isShuttingDown).to.equal(true);
      expect(C.isShuttingDown).to.equal(true);
      expect(messages("info")).to.include("Shut Down Initiated");
      expect(exitListeners).to.have.length(1);
      exitListeners[0]();
      // zero pids (restore) are not killed, a failing kill does not throw
      expect(killed).to.deep.equal([40]);
    });

    it("works without a datastore and survives an unreadable pid file", async () => {
      C.isShuttingDown = false;
      let shutdowns = 0;
      C.terminate({ shutdown: () => shutdowns++ });
      await new Promise((r) => setTimeout(r, 50));
      expect(shutdowns).to.equal(1);
    });

    it("exits 1 immediately when asked a second time", () => {
      C.isShuttingDown = true;
      let shutdowns = 0;
      let code: any;
      try {
        C.terminate({ shutdown: () => shutdowns++ });
      } catch (e: any) {
        code = e.code;
      }
      expect(code).to.equal(1);
      expect(shutdowns).to.equal(0);
      expect(messages("warn")).to.include("Shut down forced");
    });
  });

  describe("merge", () => {
    const node = (host: string) => ({
      name: host,
      neighbourhood: [{ host, port: "1" }],
    });
    const run = () => {
      try {
        CLIHandler.merge();
      } catch (e: any) {
        return e as ExitSignal;
      }
      throw new Error("merge did not exit");
    };

    it("tells you it needs configuration files when none are given", () => {
      setOptions({});
      const e = run();
      expect(e.code).to.equal(undefined);
      expect(messages("fatal")).to.deep.equal([
        "Mutiple merge arguments needed to continue.",
      ]);
    });

    it("refuses a single file, with exit code 1", () => {
      setOptions({ merge: "a.json" });
      const e = run();
      expect(e.code).to.equal(1);
      expect(messages("fatal")[0]).to.contain("--merge needs two or more");
    });

    it("writes every node's entry into every file", () => {
      fs.writeFileSync("a.json", JSON.stringify(node("a")));
      fs.writeFileSync("b.json", JSON.stringify(node("b")));
      setOptions({ merge: ["a.json", "b.json"] });
      run();
      const expected = [{ host: "a", port: "1" }, { host: "b", port: "1" }];
      expect(readJson("a.json").neighbourhood).to.deep.equal(expected);
      expect(readJson("b.json").neighbourhood).to.deep.equal(expected);
      expect(readJson("a.json").name).to.equal("a");
      expect(messages("info")).to.deep.equal([
        "Local neighbourhood configuration has been merged",
      ]);
    });

    it("rejects a file that already holds several neighbours, writing nothing", () => {
      fs.writeFileSync(
        "a.json",
        JSON.stringify({ neighbourhood: [{ host: "x" }, { host: "y" }] })
      );
      fs.writeFileSync("b.json", JSON.stringify(node("b")));
      setOptions({ merge: ["a.json", "b.json"] });
      run();
      expect(messages("fatal")).to.deep.equal([
        "a.json has multiple entries in neighbourhood",
      ]);
      expect(readJson("b.json")).to.deep.equal(node("b"));
    });

    it("reports a missing file", () => {
      fs.writeFileSync("a.json", JSON.stringify(node("a")));
      setOptions({ merge: ["a.json", "nope.json"] });
      run();
      expect(messages("fatal")).to.deep.equal([
        'Configuration file "nope.json" not found',
      ]);
      expect(readJson("a.json")).to.deep.equal(node("a"));
    });

    it("skips a file that vanished between the read and the write pass", () => {
      fs.writeFileSync("a.json", JSON.stringify(node("a")));
      fs.writeFileSync("b.json", JSON.stringify(node("b")));
      setOptions({ merge: ["a.json", "b.json"] });
      const realExists = fs.existsSync;
      let aChecks = 0;
      patch(nodeFs, "existsSync", (p: any) => {
        if (p === "a.json" && ++aChecks === 2) return false;
        return realExists(p);
      });
      run();
      expect(readJson("a.json")).to.deep.equal(node("a"));
      expect(readJson("b.json").neighbourhood).to.have.length(2);
    });
  });

  describe("checkConfig", () => {
    beforeEach(() => writeIdentity());

    it("builds config.json from the defaults plus this node's identity", () => {
      setOptions({});
      C.checkConfig();
      const cfg = readJson("config.json");
      expect(cfg.host).to.equal("127.0.0.1:5260");
      expect(cfg.db.selfhost.port).to.equal("5259");
      expect(cfg.autostart.restore).to.equal(true);
      expect(cfg.neighbourhood).to.deep.equal([
        {
          identity: { type: "rsa", public: identity.pub.pkcs8pem },
          host: "127.0.0.1",
          port: "5260",
        },
      ]);
      expect(messages("info")[0]).to.contain("Created Config File");
    });

    it("moves host and the database port with a non-default --port, and keeps restore on", () => {
      setOptions({ port: 6000, host: "10.0.0.1" });
      C.checkConfig();
      const cfg = readJson("config.json");
      expect(cfg.host).to.equal("10.0.0.1:6000");
      expect(cfg.db.selfhost.port).to.equal("5999");
      expect(cfg.autostart.restore).to.equal(true);
      expect(cfg.neighbourhood[0].host).to.equal("10.0.0.1");
      expect(cfg.neighbourhood[0].port).to.equal(6000);
    });

    it("leaves the ports alone when --port is the default 5260", () => {
      setOptions({ port: 5260, host: "10.0.0.1" });
      C.checkConfig();
      const cfg = readJson("config.json");
      expect(cfg.host).to.equal("127.0.0.1:5260");
      expect(cfg.db.selfhost.port).to.equal("5259");
    });

    it("switches the restore engine off on --disable-autostart", () => {
      setOptions({ "disable-autostart": true });
      C.checkConfig();
      expect(readJson("config.json").autostart.restore).to.equal(false);
    });

    it("uses --data-dir for the database directory", () => {
      setOptions({ "data-dir": "/some/where" });
      C.checkConfig();
      expect(readJson("config.json").db.selfhost.dir).to.equal("/some/where");
    });

    it("writes to the --config path and does nothing when it already exists", () => {
      setOptions({ config: "mine.json" });
      C.checkConfig();
      expect(fs.existsSync("mine.json")).to.equal(true);
      fs.writeFileSync("mine.json", "{\"sentinel\":true}");
      logs.length = 0;
      C.checkConfig();
      expect(readJson("mine.json")).to.deep.equal({ sentinel: true });
      expect(logs).to.have.length(0);
    });
  });

  describe("startBackup / startRestore", () => {
    const calls: any[] = [];
    beforeEach(() => {
      calls.length = 0;
      writeIdentity();
      patch(ActiveDSConnect.prototype, "backup", async function (this: any, f?: string) {
        calls.push(["backup", this.location, f]);
      });
      patch(ActiveDSConnect.prototype, "restore", async function (this: any, f: string) {
        calls.push(["restore", this.location, f]);
      });
    });

    it("backs up through the self hosted database", async () => {
      await CLIHandler.startBackup("snap");
      expect(calls).to.deep.equal([
        ["backup", "http://127.0.0.1:5259/activeledger", "snap"],
      ]);
      expect(messages("info")).to.include("Starting Backup Process");
    });

    it("restores through the self hosted database", async () => {
      await CLIHandler.startRestore("snap");
      expect(calls).to.deep.equal([
        ["restore", "http://127.0.0.1:5259/activeledger", "snap"],
      ]);
      expect(messages("info")).to.include("Starting Restore Process");
    });

    it("logs a failed backup and a failed restore", async () => {
      patch(ActiveDSConnect.prototype, "backup", async () => {
        throw new Error("boom");
      });
      patch(ActiveDSConnect.prototype, "restore", async () => {
        throw new Error("boom");
      });
      await CLIHandler.startBackup();
      await CLIHandler.startRestore("f");
      expect(messages("error")).to.deep.equal(["Backup Failed", "Restore Failed"]);
    });

    it("refuses both when the database is not self hosted", async () => {
      fs.writeFileSync(
        "config.json",
        JSON.stringify({ db: { url: "http://x", database: "d" } })
      );
      await CLIHandler.startBackup("f");
      await CLIHandler.startRestore("f");
      expect(calls).to.deep.equal([]);
      expect(messages("fatal")).to.deep.equal([
        "Backup only works using self hosted database",
        "Restore only works using self hosted database",
      ]);
    });
  });

  describe("normalStart", () => {
    // contracts/ gets a node_modules link; default_contracts is skipped
    // (its sources only exist once built) unless a test turns it on.
    const prepare = (argv: any = {}) => {
      writeIdentity();
      fs.mkdirSync("default_contracts.paused", { recursive: true });
      setOptions(argv);
    };
    const exits = (fn: () => void): ExitSignal | undefined => {
      try {
        fn();
      } catch (e: any) {
        if (e instanceof ExitSignal) return e;
        throw e;
      }
      return undefined;
    };
    let booted: any[];
    beforeEach(() => {
      booted = [];
      patch(C, "boot", (...a: any[]) => booted.push(a));
      patch(C, "assertNetwork", () => booted.push("assert"));
    });

    it("draws the start-up display for a real boot and then boots an embedded database", () => {
      prepare();
      fs.writeFileSync("config.json", "{}");
      C.version = "3.2.1";
      C.normalStart();
      const startup = logs.filter((l) => l.level.startsWith("startup.")).map((l) => [l.level, ...l.args]);
      expect(startup).to.deep.equal([
        ["startup.init", "3.2.1"],
        ["startup.begin", "config"],
        ["startup.done", "config"],
        ["startup.begin", "identity"],
        ["startup.done", "identity"],
        ["startup.begin", "database"],
        ["startup.done", "database"],
      ]);
      expect(booted).to.deep.equal([[]]);
      expect(messages("info")).to.include(
        "Activeledger Boot Process Started @ Version 3.2.1"
      );
      expect(fs.existsSync("contracts")).to.equal(true);
      expect(fs.lstatSync("contracts/node_modules").isSymbolicLink()).to.equal(true);
      expect(fs.existsSync("contracts/node_modules/@activeledger/activecontracts")).to.equal(true);
    });

    it("fails the config step and rethrows when the configuration cannot be read", () => {
      prepare();
      // a config that is not JSON
      fs.writeFileSync("config.json", "{ not json");
      let thrown: any;
      try {
        C.normalStart();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(SyntaxError);
      const fail = logs.find((l) => l.level === "startup.fail")!;
      expect(fail.args).to.deep.equal([thrown.message, "config"]);
      expect(booted).to.deep.equal([]);
    });

    it("exits 1 when the identity file is missing", () => {
      fs.mkdirSync("default_contracts.paused");
      setOptions({ identity: "./missing-identity" });
      // checkConfig needs ./.identity to build a config; give it a config
      fs.writeFileSync("config.json", JSON.stringify({}));
      const e = exits(() => C.normalStart());
      expect(e!.code).to.equal(1);
      const fail = logs.find((l) => l.level === "startup.fail")!;
      expect(fail.args).to.deep.equal(["./missing-identity not found", "identity"]);
    });

    it("skips the display for one-shot modes", () => {
      prepare({ "setup-only": true });
      const e = exits(() => C.normalStart());
      expect(e!.code).to.equal(0);
      expect(logs.filter((l) => l.level.startsWith("startup."))).to.have.length(0);
      expect(booted).to.deep.equal([]);
    });

    it("hands --assert and --assert-network to the network assertion", () => {
      prepare({ assert: true });
      C.normalStart();
      prepare({ "assert-network": true });
      C.normalStart();
      expect(booted).to.deep.equal(["assert", "assert"]);
    });

    it("prints the public key and exits", () => {
      prepare({ public: true });
      const e = exits(() => C.normalStart());
      expect(e!.code).to.equal(undefined);
      expect(messages("info")).to.include("\n" + identity.pub.pkcs8pem);
      expect(messages("fatal")).to.deep.equal([]);
    });

    describe("--sign", () => {
      const verifies = (payload: any, signature: string) =>
        new ActiveCrypto.KeyPair("rsa", identity.pub.pkcs8pem).verify(
          payload,
          signature
        );
      const signatureLogged = () => {
        const info = messages("info");
        const begin = info.indexOf("-----BEGIN SIGNATURE-----");
        expect(info[begin + 2]).to.equal("-----END SIGNATURE-----");
        return info[begin + 1];
      };

      it("signs only the $tx of a transaction file", () => {
        prepare({ sign: "tx.json" });
        const tx = { $namespace: "default", $contract: "c" };
        fs.writeFileSync("tx.json", JSON.stringify({ $tx: tx, other: 1 }));
        exits(() => C.normalStart());
        expect(messages("warn")).to.deep.equal(["Signing $tx content only"]);
        const sig = signatureLogged();
        expect(verifies(tx, sig)).to.equal(true);
        expect(verifies({ $tx: tx, other: 1 }, sig)).to.equal(false);
      });

      it("signs the whole file when there is no $tx", () => {
        prepare({ sign: "tx.json" });
        const doc = { hello: "world" };
        fs.writeFileSync("tx.json", JSON.stringify(doc));
        exits(() => C.normalStart());
        expect(messages("warn")).to.deep.equal(["Signing Entire File"]);
        expect(verifies(doc, signatureLogged())).to.equal(true);
      });

      it("signs the raw text of a file that starts with the $tx key", () => {
        prepare({ sign: "tx.txt" });
        const raw = '"$tx": {"a":1}';
        fs.writeFileSync("tx.txt", raw);
        exits(() => C.normalStart());
        expect(messages("warn")).to.deep.equal(["Signing Entire File"]);
        expect(verifies(raw, signatureLogged())).to.equal(true);
      });

      it("says so when the file is not there, and still exits", () => {
        prepare({ sign: "absent.json" });
        const e = exits(() => C.normalStart());
        expect(e).to.be.instanceOf(ExitSignal);
        expect(messages("fatal")).to.deep.equal(["File not found"]);
      });
    });

    describe("database start-up", () => {
      let timers: { fn: Function; ms: number }[];
      let launched: number;
      let extended: number;
      let extendResult: Promise<any>;
      beforeEach(() => {
        timers = [];
        launched = 0;
        extended = 0;
        extendResult = Promise.resolve();
        patch(global, "setTimeout", (fn: Function, ms: number) => {
          timers.push({ fn, ms });
          return 0;
        });
        patch(ActiveDataStore.prototype, "launch", function () {
          launched++;
          return "http://127.0.0.1:launched";
        });
        patch(ActiveOptions, "extendConfig", () => {
          extended++;
          return extendResult;
        });
      });
      const selfhostConfig = (extra: any = {}) =>
        fs.writeFileSync(
          "config.json",
          JSON.stringify({
            db: { selfhost: { port: "5259", host: "127.0.0.1" }, database: "d", ...extra },
          })
        );

      it("launches the self hosted database and extends the config two seconds later", async () => {
        prepare();
        selfhostConfig();
        const before = ActiveOptions.configVersion;
        C.normalStart();
        expect(launched).to.equal(1);
        expect(ActiveOptions.get<any>("db").url).to.equal("http://127.0.0.1:launched");
        expect(ActiveOptions.configVersion).to.be.greaterThan(before + 1);
        expect(timers).to.have.length(1);
        expect(timers[0].ms).to.equal(2000);
        expect(booted).to.deep.equal([]);
        timers[0].fn();
        await Promise.resolve();
        await Promise.resolve();
        expect(extended).to.equal(1);
        expect(booted).to.have.length(1);
        expect(logs.some((l) => l.level === "startup.done" && l.args[0] === "database")).to.equal(true);
      });

      it("reports a configuration extension failure instead of booting", async () => {
        prepare();
        selfhostConfig();
        extendResult = Promise.reject(new Error("no ledger"));
        C.normalStart();
        timers[0].fn();
        await new Promise((r) => setImmediate(r));
        expect(booted).to.deep.equal([]);
        const fail = logs.find((l) => l.level === "startup.fail")!;
        expect(fail.args).to.deep.equal(["Config Extension Issues", "database"]);
        expect(logs.find((l) => l.level === "fatal")!.args[1]).to.equal("Config Extension Issues");
      });

      it("points at a separately run database when autostart is false, and checks it is up", async () => {
        prepare();
        selfhostConfig({ autostart: false });
        const sent: any[] = [];
        patch(ActiveRequest, "send", (...a: any[]) => {
          sent.push(a);
          return Promise.reject(new Error("down"));
        });
        C.normalStart();
        expect(launched).to.equal(0);
        expect(ActiveOptions.get<any>("db").url).to.equal("http://127.0.0.1:5259");
        expect(sent).to.deep.equal([["http://127.0.0.1:5259", "GET"]]);
        await new Promise((r) => setImmediate(r));
        expect(logs.find((l) => l.level === "startup.fail")!.args).to.deep.equal([
          "Database Not Running",
          "database",
        ]);
        expect(messages("fatal")).to.deep.equal([
          "Database Not Running - http://127.0.0.1:5259",
        ]);
      });

      it("--db-only launches the database even when autostart is false and never boots", () => {
        prepare({ "db-only": true });
        selfhostConfig({ autostart: false });
        C.normalStart();
        expect(launched).to.equal(1);
        expect(timers).to.have.length(0);
        expect(booted).to.deep.equal([]);
        // db-only is not a normal boot, so no start-up display
        expect(logs.filter((l) => l.level === "startup.init")).to.have.length(0);
      });

      it("--db-only without a self hosted database is fatal", () => {
        prepare({ "db-only": true });
        fs.writeFileSync("config.json", JSON.stringify({ db: { url: "x" } }));
        C.normalStart();
        expect(messages("fatal")).to.deep.equal([
          "Cannot start embedded database. Self hosted is not configured",
        ]);
        expect(booted).to.deep.equal([]);
      });
    });

    describe("default contracts", () => {
      it("copies the five default contracts and links their node_modules", () => {
        writeIdentity();
        setOptions({ "setup-only": true });
        const copies: string[][] = [];
        patch(nodeFs, "copyFileSync", (a: string, b: string) => copies.push([a, b]));
        exits(() => C.normalStart());
        expect(copies.map((c) => c[1])).to.deep.equal(
          ["contract.js", "namespace.js", "onboard.js", "setup.js", "hybrid.js"].map(
            (f) => `./default_contracts/${f}`
          )
        );
        for (const [src, dest] of copies) {
          expect(path.basename(src)).to.equal(path.basename(dest));
          expect(src).to.contain(path.join("contracts", "default"));
        }
        expect(fs.lstatSync("default_contracts/node_modules").isSymbolicLink()).to.equal(true);
      });

      it("leaves default_contracts alone while it is paused", () => {
        prepare({ "setup-only": true });
        const copies: string[][] = [];
        patch(nodeFs, "copyFileSync", (a: string, b: string) => copies.push([a, b]));
        exits(() => C.normalStart());
        expect(copies).to.deep.equal([]);
        expect(fs.existsSync("default_contracts")).to.equal(false);
      });

      it("fails with a clear message when no node_modules holds the contracts package", () => {
        prepare({ "setup-only": true });
        const realExists = fs.existsSync;
        patch(nodeFs, "existsSync", (p: any) =>
          String(p).endsWith("@activeledger/activecontracts") ? false : realExists(p)
        );
        expect(() => C.normalStart()).to.throw(
          /Could not find a node_modules containing @activeledger\/activecontracts \(searched \d+ locations/
        );
      });
    });
  });

  describe("boot", () => {
    let seen: { ev: string; fn: Function }[];
    let offs: string[];
    let spawned: any[];
    let spawnedChild: any;
    let initialised: any[];
    let intervals: { fn: Function; ms: number; cleared: boolean }[];
    const bindingStatics = ["bindingHost", "bindingPort"];
    let savedBinding: any[];

    beforeEach(() => {
      seen = [];
      offs = [];
      spawned = [];
      initialised = [];
      intervals = [];
      writeIdentity();
      savedBinding = bindingStatics.map((k) => (ActiveInterfaces as any)[k]);
      (ActiveInterfaces as any).bindingHost = undefined;
      (ActiveInterfaces as any).bindingPort = undefined;
      spawnedChild = {
        pid: 4242,
        on(ev: string, fn: Function) {
          spawnedChild.handlers[ev] = fn;
          return spawnedChild;
        },
        handlers: {} as any,
      };
      patch(ActiveNetwork.Maintain, "init", (h: any) => initialised.push(h));
      patch(process, "on", (ev: string, fn: Function) => {
        seen.push({ ev, fn });
        return process;
      });
      patch(process, "off", (ev: string, fn: Function) => {
        offs.push(`${ev}:${fn === C.earlyShutdown}`);
        return process;
      });
      // The Host constructor forks its processors: hand it inert fakes
      patch(nodeChild, "fork", () => {
        const fake: any = new EventEmitter();
        fake.send = () => true;
        fake.kill = () => true;
        fake.pid = 1;
        return fake;
      });
      patch(nodeChild, "spawn", (...a: any[]) => {
        spawned.push(a);
        return spawnedChild;
      });
      patch(global, "setInterval", (fn: Function, ms: number) => {
        const rec = { fn, ms, cleared: false };
        intervals.push(rec);
        return { unref: () => undefined, rec } as any;
      });
      patch(global, "clearInterval", (t: any) => {
        t.rec.cleared = true;
      });
      patch(C.pidHandler, "addPid", async (c: any, pid: number) => {
        seen.push({ ev: "addPid", fn: () => [c, pid] });
      });
      patch(ActiveNetwork.Host.prototype, "getStatus", () => ActiveNetwork.NeighbourStatus.Pairing);
    });
    afterEach(() => {
      (ActiveNetwork.Host as any).onListening = undefined;
      bindingStatics.forEach((k, i) => ((ActiveInterfaces as any)[k] = savedBinding[i]));
    });

    const config = (extra: any = {}) => ({
      host: "127.0.0.1:5260",
      configVersion: 1,
      cpus: 1,
      neighbourhood: [
        {
          identity: { type: "rsa", public: identity.pub.pkcs8pem },
          host: "127.0.0.1",
          port: "5260",
        },
      ],
      ...extra,
    });
    const pidsAdded = () =>
      seen.filter((s) => s.ev === "addPid").map((s) => s.fn());

    it("exits 1 when the host cannot be created", async () => {
      setOptions({ identity: "./nope" }, config());
      let code: any;
      try {
        await C.boot();
      } catch (e: any) {
        code = e.code;
      }
      expect(code).to.equal(1);
    });

    it("maintains the neighbourhood, swaps the early signal handlers and reports progress", async () => {
      setOptions({}, config({ autostart: {} }));
      const ds: any = {};
      const terminated: any[] = [];
      patch(C, "terminate", (h: any, d: any) => terminated.push([h, d]));
      await C.boot(ds);
      expect(ActiveOptions.get("__base")).to.equal(
        path.resolve(__dirname, "../packages/activeledger/src/cli") + "/.."
      );
      expect(initialised).to.have.length(1);
      expect(initialised[0]).to.be.instanceOf(ActiveNetwork.Host);
      expect(offs).to.deep.equal(["SIGINT:true", "SIGTERM:true", "SIGQUIT:true"]);
      const signals = seen.filter((s) => s.ev.startsWith("SIG"));
      expect(signals.map((s) => s.ev)).to.deep.equal(["SIGINT", "SIGTERM", "SIGQUIT"]);
      signals.forEach((s) => s.fn());
      expect(terminated).to.have.length(3);
      for (const t of terminated) {
        expect(t[0]).to.equal(initialised[0]);
        expect(t[1]).to.equal(ds);
      }
      // listening: network done, consensus begun, polling every 300ms until stable
      logs.length = 0;
      (ActiveNetwork.Host as any).onListening();
      expect(intervals).to.have.length(1);
      expect(intervals[0].ms).to.equal(300);
      expect(logs.map((l) => [l.level, l.args[0]])).to.deep.equal([
        ["startup.done", "network"],
        ["startup.begin", "consensus"],
      ]);
      intervals[0].fn();
      expect(intervals[0].cleared).to.equal(false);
      patch(ActiveNetwork.Host.prototype, "getStatus", () => ActiveNetwork.NeighbourStatus.Stable);
      logs.length = 0;
      intervals[0].fn();
      expect(intervals[0].cleared).to.equal(true);
      expect(logs.map((l) => [l.level, l.args[0]])).to.deep.equal([
        ["startup.done", "consensus"],
        ["startup.begin", "ready"],
        ["startup.done", "ready"],
        ["startup.finish", undefined],
      ]);
    });

    it("notes a config that predates configVersion, and stays quiet for one that has it", async () => {
      setOptions({}, { ...config(), configVersion: undefined });
      await C.boot();
      expect(messages("info")).to.have.length(1);
      expect(messages("info")[0]).to.contain("config.json predates configVersion");
      logs.length = 0;
      setOptions({}, config());
      await C.boot();
      expect(messages("info")).to.deep.equal([]);
    });

    it("warns when the restore engine is switched off, and does not spawn it", async () => {
      setOptions({}, config({ autostart: { restore: false } }));
      await C.boot();
      expect(messages("warn")).to.have.length(1);
      expect(messages("warn")[0]).to.contain("autostart.restore is false");
      expect(spawned).to.deep.equal([]);
      expect(pidsAdded()).to.deep.equal([]);
    });

    it("warns that autostart.core is gone but does not start it", async () => {
      setOptions({}, config({ autostart: { core: true } }));
      await C.boot();
      expect(messages("warn")).to.have.length(1);
      expect(messages("warn")[0]).to.contain("ActiveCore was removed in Activeledger 5.0.0");
      expect(spawned).to.deep.equal([]);
    });

    it("starts the restore engine from its resolved script and records its pid", async () => {
      setOptions({}, config({ autostart: { restore: true } }));
      await C.boot();
      expect(spawned).to.have.length(1);
      const [cmd, args, opts] = spawned[0];
      expect(cmd).to.equal(process.execPath);
      expect(args).to.have.length(1);
      const restorePkg = path.resolve(__dirname, "../packages/restore");
      const bin = JSON.parse(fs.readFileSync(path.join(restorePkg, "package.json"), "utf8")).bin;
      const rel = typeof bin === "string" ? bin : Object.values(bin)[0];
      expect(args[0]).to.equal(fs.realpathSync(path.join(restorePkg, rel as string)));
      expect(opts).to.deep.equal({ cwd: "./", stdio: "inherit" });
      expect(messages("info")).to.include("Auto starting - Restore Engine");
      expect(pidsAdded()).to.deep.equal([[EPIDChild.RESTORE, 4242]]);
      spawnedChild.handlers.error(new Error("spawn failed"));
      const err = logs.find((l) => l.level === "error")!;
      expect(err.args[1]).to.equal(`Restore Engine Failed to start (${args[0]})`);
    });

    it("records pid 0 when the restore engine has no pid", async () => {
      spawnedChild.pid = undefined;
      setOptions({}, config({ autostart: { restore: true } }));
      await C.boot();
      expect(pidsAdded()).to.deep.equal([[EPIDChild.RESTORE, 0]]);
    });

    describe("when the restore script cannot be resolved", () => {
      const realRead = nodeFs.readFileSync;
      const realExists = nodeFs.existsSync;
      const run = async () => {
        setOptions({}, config({ autostart: { restore: true } }));
        await C.boot();
      };

      it("falls back to the activerestore command when the manifest is unreadable", async () => {
        patch(nodeFs, "readFileSync", (p: any, ...r: any[]) => {
          if (String(p).endsWith("activerestore/package.json")) throw new Error("EIO");
          return realRead(p, ...r);
        });
        await run();
        expect(spawned).to.have.length(1);
        expect(spawned[0][0]).to.equal("activerestore");
        expect(spawned[0][1]).to.deep.equal([]);
        expect(spawned[0][2]).to.deep.equal({ cwd: "./", stdio: "inherit" });
        spawnedChild.handlers.error(new Error("ENOENT"));
        expect(logs.find((l) => l.level === "error")!.args[1]).to.equal(
          "Restore Engine Failed to start - activerestore is not on PATH and could not be resolved"
        );
      });

      it("falls back when the manifest names no usable bin", async () => {
        patch(nodeFs, "readFileSync", (p: any, ...r: any[]) =>
          String(p).endsWith("activerestore/package.json")
            ? JSON.stringify({ bin: {} })
            : realRead(p, ...r)
        );
        await run();
        expect(spawned[0][0]).to.equal("activerestore");
      });

      it("falls back when the bin it names does not exist", async () => {
        patch(nodeFs, "readFileSync", (p: any, ...r: any[]) =>
          String(p).endsWith("activerestore/package.json")
            ? JSON.stringify({ bin: "missing/entry.js" })
            : realRead(p, ...r)
        );
        await run();
        expect(spawned[0][0]).to.equal("activerestore");
      });

      it("accepts a string bin and uses activerestore.cmd on Windows", async () => {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        patch(nodeFs, "readFileSync", (p: any, ...r: any[]) =>
          String(p).endsWith("activerestore/package.json")
            ? JSON.stringify({ bin: "nowhere.js" })
            : realRead(p, ...r)
        );
        // Only the spawn decision should see Windows, not the host set-up
        restores.push(() => Object.defineProperty(process, "platform", platform));
        patch(ActiveNetwork.Maintain, "init", () =>
          Object.defineProperty(process, "platform", { value: "win32" })
        );
        await run();
        expect(spawned[0][0]).to.equal("activerestore.cmd");
      });

      it("takes the first bin of an object bin", async () => {
        patch(nodeFs, "readFileSync", (p: any, ...r: any[]) =>
          String(p).endsWith("activerestore/package.json")
            ? JSON.stringify({ bin: { a: "lib/index.js", b: "other.js" } })
            : realRead(p, ...r)
        );
        patch(nodeFs, "existsSync", (p: any) =>
          String(p).endsWith("activerestore/lib/index.js") ? true : realExists(p)
        );
        patch(nodeFs, "realpathSync", (p: any) => `real:${p}`);
        await run();
        expect(spawned[0][0]).to.equal(process.execPath);
        expect(spawned[0][1][0]).to.match(/^real:.*activerestore\/lib\/index\.js$/);
      });
    });
  });

  describe("assertNetwork", () => {
    const flush = () => new Promise((r) => setImmediate(r));
    let exitCodes: number[];
    let sent: any[];
    let responses: ((url: string, method: string, h?: any, body?: any) => Promise<any>);
    let timers: { fn: Function; ms: number }[];

    beforeEach(() => {
      writeIdentity();
      exitCodes = [];
      sent = [];
      timers = [];
      patch(process, "exit", (c?: number) => {
        exitCodes.push(c as number);
        throw new ExitSignal(c);
      });
      patch(global, "setTimeout", (fn: Function, ms: number) => {
        timers.push({ fn, ms });
        return 0;
      });
      patch(ActiveRequest, "send", (url: string, method: string, h?: any, body?: any) => {
        sent.push({ url, method, body });
        return responses(url, method, h, body);
      });
    });

    const status = (homes: boolean[]) => ({
      data: {
        neighbourhood: {
          neighbours: Object.fromEntries(homes.map((h, i) => [`n${i}`, { isHome: h }])),
        },
      },
    });

    it("refuses when the network was already asserted", () => {
      setOptions({ assert: true }, { network: "asserted" });
      expect(() => C.assertNetwork()).to.throw(ExitSignal);
      expect(messages("error")).to.deep.equal(["Network has already been asserted"]);
      expect(sent).to.deep.equal([]);
    });

    it("insists every known node is online first", async () => {
      setOptions({ assert: true, host: "h:1" });
      responses = async () => status([true, false]);
      C.assertNetwork();
      await flush();
      expect(messages("fatal")[0]).to.equal(
        "All known nodes must been online for assertion"
      );
      expect(exitCodes).to.have.length.greaterThan(0);
      // nothing was submitted
      expect(sent).to.have.length(1);
      expect(sent[0]).to.deep.include({ url: "http://h:1/a/status", method: "GET" });
    });

    const goodSetup = (argv: any, config: any = {}) =>
      setOptions(argv, {
        security: { s: 1 },
        consensus: { reached: 60 },
        neighbourhood: [{ host: "x" }],
        ...config,
      });

    it("submits a self signed setup/assert transaction and exits 0 on success", async () => {
      goodSetup({ assert: "lockme", host: "h:1" });
      responses = async (url, method) =>
        method === "GET"
          ? status([true, true])
          : { data: { $summary: { errors: 0 }, $streams: { new: [] } } };
      C.assertNetwork();
      await flush();
      await flush();
      const post = sent.find((s) => s.method === "POST");
      expect(post.url).to.equal("http://h:1");
      const tx = post.body.$tx;
      expect(tx.$namespace).to.equal("default");
      expect(tx.$contract).to.equal("setup");
      expect(tx.$entry).to.equal("assert");
      expect(tx.$i["h:1"]).to.deep.equal({ type: "rsa", publicKey: identity.pub.pkcs8pem });
      expect(tx.$i.setup.lock).to.equal("lockme");
      expect(tx.$i.setup.security).to.deep.equal({ s: 1 });
      expect(tx.$i.setup.consensus).to.deep.equal({ reached: 60 });
      expect(tx.$i.setup.neighbourhood).to.deep.equal([{ host: "x" }]);
      expect(tx.$i.setup).to.not.have.property("hybrid");
      expect(post.body.$selfsign).to.equal(true);
      const pub = new ActiveCrypto.KeyPair("rsa", identity.pub.pkcs8pem);
      expect(post.body.$sigs["h:1"]).to.equal(post.body.$sigs.setup);
      expect(pub.verify(tx, post.body.$sigs.setup)).to.equal(true);
      expect(messages("info")).to.include("Network Asserted to the ledger");
      expect(timers[0].ms).to.equal(200);
      try {
        timers[0].fn();
      } catch {}
      expect(exitCodes).to.deep.equal([0]);
    });

    it("uses an empty lock for a bare --assert-network and includes a hybrid section", async () => {
      goodSetup(
        { "assert-network": true, host: "h:1" },
        { hybrid: { admission: "open", required: [] } }
      );
      responses = async (url, method) =>
        method === "GET"
          ? status([])
          : { data: { $summary: {}, $streams: {} } };
      C.assertNetwork();
      await flush();
      await flush();
      const post = sent.find((s) => s.method === "POST");
      expect(post.body.$tx.$i.setup.lock).to.equal("");
      expect(post.body.$tx.$i.setup.hybrid).to.deep.equal({
        admission: "open",
        required: [],
      });
    });

    it("fatals with the summary and exits 1 when the ledger reports errors", async () => {
      goodSetup({ assert: true, host: "h:1" });
      const summary = { errors: ["bad"] };
      responses = async (url, method) =>
        method === "GET" ? status([true]) : { data: { $summary: summary } };
      C.assertNetwork();
      await flush();
      await flush();
      const fatal = logs.find((l) => l.level === "fatal")!;
      expect(fatal.args).to.deep.equal([summary, "Networking Assertion Failed"]);
      try {
        timers[0].fn();
      } catch {}
      expect(exitCodes).to.deep.equal([1]);
    });

    it("exits 1 when submitting the transaction fails", async () => {
      goodSetup({ assert: true, host: "h:1" });
      responses = async (url, method) => {
        if (method === "GET") return status([true]);
        throw new Error("down");
      };
      C.assertNetwork();
      await flush();
      await flush();
      expect(messages("fatal")).to.deep.equal(["Networking Assertion Failed"]);
      try {
        timers[0].fn();
      } catch {}
      expect(exitCodes).to.deep.equal([1]);
    });

    it("exits 1, with the response body, when the status check fails", async () => {
      goodSetup({ assert: true, host: "h:1" });
      responses = async () => {
        const e: any = new Error("http");
        e.response = { data: { reason: "x" } };
        throw e;
      };
      C.assertNetwork();
      await flush();
      const fatal = logs.find((l) => l.level === "fatal")!;
      expect(fatal.args).to.deep.equal([{ reason: "x" }, "Unable to assess network for assertion"]);
      try {
        timers[0].fn();
      } catch {}
      expect(exitCodes).to.deep.equal([1]);
    });

    it("passes the raw error on when it carries no response", async () => {
      goodSetup({ assert: true, host: "h:1" });
      const err = new Error("refused");
      responses = async () => {
        throw err;
      };
      C.assertNetwork();
      await flush();
      expect(logs.find((l) => l.level === "fatal")!.args[0]).to.equal(err);
    });
  });
});
