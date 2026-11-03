import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { Host } from "../packages/network/src/network/host";
import {
  DEFAULT_WORKER_SEMI_SPACE_MB,
  workerExecArgv,
  workerSemiSpaceMb,
} from "../packages/network/src/network/workerheap";

// The mutable CommonJS module (not an import namespace) is patched.
const childProcess: any = require("child_process");

/**
 * worker_semi_space caps the young generation of the contract worker
 * processes (about 100 MB of slack each otherwise). It must reach workers
 * and only workers, and a value that cannot be used must never stop a
 * worker starting.
 */
describe("Worker V8 heap flags (Activenetwork)", () => {
  const config = ActiveOptions.fetch(false);
  const realWarn = ActiveLogger.warn;
  let saved: unknown;
  let hadKey: boolean;
  let warnings: string[];

  beforeEach(() => {
    hadKey = "worker_semi_space" in config;
    saved = config.worker_semi_space;
    delete config.worker_semi_space;
    warnings = [];
    (ActiveLogger as any).warn = (m: any) => warnings.push(String(m));
  });

  afterEach(() => {
    (ActiveLogger as any).warn = realWarn;
    if (hadKey) config.worker_semi_space = saved;
    else delete config.worker_semi_space;
  });

  describe("the setting", () => {
    it("is the shipped default when not configured", () => {
      expect(workerSemiSpaceMb()).to.equal(DEFAULT_WORKER_SEMI_SPACE_MB);
      expect(warnings).to.deep.equal([]);
    });

    it("accepts a whole number of MB, as a number or as a CLI string", () => {
      config.worker_semi_space = 2;
      expect(workerSemiSpaceMb()).to.equal(2);
      config.worker_semi_space = "4";
      expect(workerSemiSpaceMb()).to.equal(4);
      config.worker_semi_space = 64;
      expect(workerSemiSpaceMb()).to.equal(64);
      expect(warnings).to.deep.equal([]);
    });

    it("0 and false switch it off without a warning", () => {
      for (const off of [0, "0", false, "false"]) {
        config.worker_semi_space = off;
        expect(workerSemiSpaceMb(), String(off)).to.equal(0);
      }
      expect(warnings).to.deep.equal([]);
    });

    it("falls back to no flag, with a warning, for anything unusable", () => {
      const bad = [-1, 1.5, "1.5", "two", "2MB", 65, 1e9, "", true, [], {}, NaN];
      for (const value of bad) {
        warnings.length = 0;
        config.worker_semi_space = value;
        expect(workerSemiSpaceMb(), JSON.stringify(value)).to.equal(0);
        expect(warnings.length, JSON.stringify(value)).to.equal(1);
        expect(warnings[0]).to.contain("worker_semi_space");
        expect(workerExecArgv([]), JSON.stringify(value)).to.deep.equal([]);
      }
    });
  });

  describe("execArgv", () => {
    it("adds the flag after whatever the host was started with", () => {
      config.worker_semi_space = 2;
      expect(workerExecArgv(["--no-warnings"])).to.deep.equal([
        "--no-warnings",
        "--max-semi-space-size=2",
      ]);
    });

    it("adds nothing when the setting is 0", () => {
      config.worker_semi_space = 0;
      expect(workerExecArgv(["--no-warnings"])).to.deep.equal(["--no-warnings"]);
    });
  });

  describe("Host.createProcessor", () => {
    let realFork: any;
    let forks: { file: string; opts: any }[];

    beforeEach(() => {
      forks = [];
      realFork = childProcess.fork;
      childProcess.fork = (file: string, _args: string[], opts: any) => {
        forks.push({ file, opts });
        const child: any = new EventEmitter();
        child.pid = 9100 + forks.length;
        child.send = () => true;
        child.kill = () => true;
        return child;
      };
    });

    afterEach(() => {
      childProcess.fork = realFork;
    });

    const create = () => {
      const host: any = Object.create(Host.prototype);
      host.processors = [];
      return host.createProcessor(1);
    };

    it("starts a worker with the configured flag", () => {
      config.worker_semi_space = 2;
      create();
      expect(forks).to.have.length(1);
      expect(forks[0].file).to.match(/process\.js$/);
      expect(forks[0].opts.execArgv).to.include("--max-semi-space-size=2");
    });

    it("starts a worker with no heap flag when not configured", () => {
      config.worker_semi_space = 0;
      create();
      expect(
        forks[0].opts.execArgv.filter((a: string) => a.includes("semi-space"))
      ).to.deep.equal([]);
    });

    it("still starts a worker, without the flag, when the value is invalid", () => {
      config.worker_semi_space = "lots";
      create();
      expect(forks).to.have.length(1);
      expect(
        forks[0].opts.execArgv.filter((a: string) => a.includes("semi-space"))
      ).to.deep.equal([]);
      expect(warnings.length).to.equal(1);
    });

    it("does not touch the worker's memory limit setting", () => {
      config.worker_semi_space = 2;
      const before = ActiveOptions.get<number>("max_memory", 1500);
      create();
      expect(ActiveOptions.get<number>("max_memory", 1500)).to.equal(before);
    });
  });
});
