import { ActiveLogger, ActiveTiming } from "../packages/logger/src/index";
import { expect } from "chai";
import "mocha";
import { spawnSync } from "child_process";
import * as path from "path";

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");

describe("ActiveLogger", () => {
  const lines: string[] = [];
  let winston: { level: string; args: any[] }[];
  const savedWinston = ActiveLogger.WinstonLogger;
  const savedSink = ActiveLogger.sink;
  const savedDebug = ActiveLogger.enableDebug;
  const savedVM = ActiveLogger.isVMRuntime;

  beforeEach(() => {
    lines.length = 0;
    winston = [];
    ActiveLogger.sink = (line: string) => lines.push(line);
    ActiveLogger.WinstonLogger = undefined;
    ActiveLogger.enableDebug = false;
    ActiveLogger.isVMRuntime = false;
  });

  afterEach(() => {
    ActiveLogger.sink = savedSink;
    ActiveLogger.WinstonLogger = savedWinston;
    ActiveLogger.enableDebug = savedDebug;
    ActiveLogger.isVMRuntime = savedVM;
  });

  const fakeWinston = () =>
    ["debug", "info", "warn", "error"].reduce((w: any, level) => {
      w[level] = (...args: any[]) => winston.push({ level, args });
      return w;
    }, {});

  describe("line format", () => {
    it("carries timestamp, level, padded pid and message", () => {
      ActiveLogger.info("hello");
      expect(lines).to.have.length(1);
      const plain = strip(lines[0]);
      expect(plain).to.match(
        new RegExp(
          `^\\[\\d{13}\\] INFO  \\(Activeledger/${process.pid
            .toString()
            .padStart(5, "0")}\\) hello$`
        )
      );
    });

    it("appends a pretty printed object when a message is also given", () => {
      ActiveLogger.info({ a: 1 }, "with object");
      const plain = strip(lines[0]);
      expect(plain).to.contain("with object");
      expect(plain).to.contain("[ OBJECT ]");
      expect(plain).to.contain(JSON.stringify({ a: 1 }, null, 2));
    });

    it("leaves an empty object out", () => {
      ActiveLogger.info({}, "empty");
      expect(strip(lines[0])).to.not.contain("OBJECT");
    });

    it("falls back to toString for a circular object", () => {
      const circular: any = { name: "loop" };
      circular.self = circular;
      circular.toString = () => "CIRCULAR-STRING";
      ActiveLogger.warn(circular, "circular");
      const plain = strip(lines[0]);
      expect(plain).to.contain("[ toString() ]");
      expect(plain).to.contain("CIRCULAR-STRING");
    });

    it("prints nothing extra for undefined and un-stringifiable objects", () => {
      ActiveLogger.info(undefined as any, "undef");
      expect(strip(lines[0]).endsWith("undef")).to.equal(true);
      const bare = Object.create(null);
      bare.self = bare;
      ActiveLogger.info(bare, "bare");
      expect(strip(lines[1]).endsWith("bare")).to.equal(true);
    });

    it("colours VM runtime output differently", () => {
      ActiveLogger.info("host side");
      ActiveLogger.setVMRuntime(true);
      expect(ActiveLogger.isVMRuntime).to.equal(true);
      ActiveLogger.info("vm side");
      expect(lines[0]).to.contain("\x1b[36mhost side");
      expect(lines[1]).to.contain("\x1b[93mvm side");
      ActiveLogger.setVMRuntime(false);
      expect(ActiveLogger.isVMRuntime).to.equal(false);
    });
  });

  describe("levels", () => {
    it("labels info, warn, error and fatal", () => {
      ActiveLogger.info("i");
      ActiveLogger.warn("w");
      ActiveLogger.error("e");
      ActiveLogger.fatal("f");
      expect(lines.map((l) => /\] (\w+)\s/.exec(strip(l))![1])).to.deep.equal([
        "INFO",
        "WARN",
        "ERROR",
        "FATAL",
      ]);
    });

    it("hides debug unless enabled", () => {
      ActiveLogger.debug("quiet");
      expect(lines).to.have.length(0);
      ActiveLogger.enableDebug = true;
      ActiveLogger.debug("loud");
      expect(lines).to.have.length(1);
      expect(strip(lines[0])).to.contain("DEBUG");
    });

    it("hides trace unless debug is enabled, and traces when it is", () => {
      const savedTrace = console.trace;
      let traced = 0;
      console.trace = () => {
        traced++;
      };
      try {
        ActiveLogger.trace("quiet");
        expect(lines).to.have.length(0);
        expect(traced).to.equal(0);
        ActiveLogger.enableDebug = true;
        ActiveLogger.trace("loud");
        expect(lines).to.have.length(1);
        expect(strip(lines[0])).to.contain("TRACE");
        expect(traced).to.equal(1);
      } finally {
        console.trace = savedTrace;
      }
    });

    it("fatal returns a throwable error carrying the message", () => {
      const e = ActiveLogger.fatal({ detail: 1 }, "went wrong");
      expect(e).to.be.instanceOf(Error);
      expect(e.message).to.equal("went wrong");
      const e2 = ActiveLogger.fatal("only message");
      expect(e2.message).to.equal("only message");
    });
  });

  describe("without a sink", () => {
    it("writes to the matching console method", () => {
      ActiveLogger.sink = undefined;
      ActiveLogger.enableDebug = true;
      const seen: Record<string, string[]> = {};
      const saved: Record<string, any> = {};
      for (const m of ["info", "warn", "error", "debug"] as const) {
        saved[m] = console[m];
        seen[m] = [];
        console[m] = (s: string) => {
          seen[m].push(strip(s));
        };
      }
      try {
        ActiveLogger.info("a");
        ActiveLogger.warn("b");
        ActiveLogger.error("c");
        ActiveLogger.fatal("d");
        ActiveLogger.debug("e");
      } finally {
        for (const m of Object.keys(saved)) (console as any)[m] = saved[m];
      }
      expect(seen.info).to.have.length(1);
      expect(seen.info[0]).to.match(/INFO .* a$/);
      expect(seen.warn).to.have.length(1);
      expect(seen.warn[0]).to.match(/WARN .* b$/);
      expect(seen.error).to.have.length(2);
      expect(seen.error[0]).to.match(/ERROR .* c$/);
      expect(seen.error[1]).to.match(/FATAL .* d$/);
      expect(seen.debug).to.have.length(1);
      expect(seen.debug[0]).to.match(/DEBUG .* e$/);
    });
  });

  describe("winston mirror", () => {
    it("forwards levels to the winston logger", () => {
      ActiveLogger.WinstonLogger = fakeWinston();
      ActiveLogger.enableDebug = true;
      ActiveLogger.debug({ d: 1 }, "dbg");
      ActiveLogger.info({ i: 1 }, "inf");
      ActiveLogger.warn({ w: 1 }, "wrn");
      ActiveLogger.error({ e: 1 }, "err");
      ActiveLogger.fatal({ f: 1 }, "ftl");
      expect(winston).to.deep.equal([
        { level: "debug", args: [{ d: 1 }, "dbg"] },
        { level: "info", args: [{ i: 1 }, "inf"] },
        { level: "warn", args: [{ w: 1 }, "wrn"] },
        { level: "error", args: [{ e: 1 }, "err"] },
        { level: "error", args: [{ f: 1 }, "ftl"] },
      ]);
    });

    it("does not forward debug when debug is off", () => {
      ActiveLogger.WinstonLogger = fakeWinston();
      ActiveLogger.debug("no");
      expect(winston).to.have.length(0);
    });
  });

  describe("instance proxies", () => {
    it("behave like the static methods", () => {
      const logger = new ActiveLogger();
      ActiveLogger.enableDebug = true;
      ActiveLogger.WinstonLogger = fakeWinston();
      const savedTrace = console.trace;
      console.trace = () => undefined;
      try {
        logger.trace("t");
      } finally {
        console.trace = savedTrace;
      }
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      logger.fatal("f");
      const labels = lines.map((l) => /\] (\w+)\s/.exec(strip(l))![1]);
      expect(labels).to.deep.equal([
        "TRACE",
        "DEBUG",
        "INFO",
        "WARN",
        "ERROR",
        "FATAL",
      ]);
      expect(winston.map((w) => w.level)).to.deep.equal([
        "debug",
        "info",
        "warn",
        "error",
        "error",
      ]);
      logger.setVMRuntime(true);
      expect(ActiveLogger.isVMRuntime).to.equal(true);
    });
  });
});

describe("ActiveTiming", () => {
  const cwd = path.resolve(__dirname, "..");
  const script =
    'const { ActiveTiming } = require("./packages/logger/src/index");' +
    'ActiveTiming.mark("umid-1", "stage.a");' +
    'ActiveTiming.mark(undefined, "ignored");' +
    'ActiveTiming.mark("", "ignored");';
  const run = (env: Record<string, string>) => {
    const clean = { ...process.env };
    delete clean.ACTIVELEDGER_PROFILE;
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { cwd, env: { ...clean, ...env }, encoding: "utf8" }
    );
  };

  it("writes nothing unless ACTIVELEDGER_PROFILE is set", () => {
    const r = run({});
    expect(r.status).to.equal(0);
    expect(r.stdout).to.equal("");
  });

  it("writes one absolute-timestamp line per mark when enabled", () => {
    const r = run({ ACTIVELEDGER_PROFILE: "1" });
    expect(r.status).to.equal(0);
    const out = r.stdout.trim().split("\n");
    expect(out).to.have.length(1);
    expect(out[0]).to.match(/^\[PROF\] umid-1 stage\.a \d+\.\d{3}$/);
    const at = Number(out[0].split(" ")[3]);
    expect(Math.abs(at - Date.now())).to.be.lessThan(60000);
  });

  it("is disabled in the test process by default", () => {
    expect(ActiveTiming.enabled).to.equal(!!process.env.ACTIVELEDGER_PROFILE);
  });
});
