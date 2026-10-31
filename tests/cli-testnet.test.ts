import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveOptions } from "@activeledger/activeoptions";
import { TestnetHandler } from "../packages/activeledger/src/cli/testnet";

// The mutable CommonJS modules (not import namespaces) are patched, which is
// what the handler under test reads from.
const cp: any = require("child_process");

// TestnetHandler.setup() launches `activeledger` per instance, waits two
// seconds, then merges the configs and calls process.exit. Here exec, the
// timers and process.exit are replaced so nothing is launched, nothing waits
// and the run can be stepped through; the folders and files it makes are
// real, in a temporary working directory.
describe("TestnetHandler (activeledger --testnet)", () => {
  const startDir = process.cwd();
  const realExec = cp.exec;
  const realExit = process.exit;
  const realSetTimeout = global.setTimeout;
  const config = ActiveOptions.fetch(false);
  const argv = ActiveOptions.fetch(true);
  let savedTestnet: { config: any; argv: any };
  let tmpDir: string;
  let execs: { cmd: string; opts: any; killed: string[]; handlers: any }[];
  let timers: (() => void)[];
  let exits: number;

  const flush = () => new Promise<void>((r) => setImmediate(r));

  // Fire the per-instance shutdown timers, then let the merge start
  const finishInstances = async () => {
    timers.splice(0).forEach((t) => t());
    await flush();
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-testnet-"));
    process.chdir(tmpDir);
    fs.writeFileSync(".identity", '{"shared":"identity"}');
    savedTestnet = { config: config.testnet, argv: argv.testnet };
    delete config.testnet;
    execs = [];
    timers = [];
    exits = 0;
    cp.exec = (cmd: string, opts: any) => {
      const rec = {
        cmd,
        opts,
        killed: [] as string[],
        handlers: {} as any,
      };
      execs.push(rec);
      return {
        kill: (sig: string) => rec.killed.push(sig),
        on: (ev: string, fn: () => void) => (rec.handlers[ev] = fn),
      };
    };
    (global as any).setTimeout = (fn: () => void) => {
      timers.push(fn);
      return 0 as any;
    };
    (process as any).exit = () => {
      exits++;
    };
  });

  afterEach(() => {
    cp.exec = realExec;
    (process as any).exit = realExit;
    (global as any).setTimeout = realSetTimeout;
    process.chdir(startDir);
    if (savedTestnet.config === undefined) delete config.testnet;
    else config.testnet = savedTestnet.config;
    if (savedTestnet.argv === undefined) delete argv.testnet;
    else argv.testnet = savedTestnet.argv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds three instances by default", () => {
    config.testnet = true;
    TestnetHandler.setup();
    expect(fs.readdirSync(".").filter((f) => f.startsWith("instance-")).sort())
      .to.deep.equal(["instance-0", "instance-1", "instance-2"]);
    expect(execs).to.have.length(3);
  });

  it("builds the number of instances asked for", () => {
    config.testnet = "2";
    TestnetHandler.setup();
    expect(fs.readdirSync(".").filter((f) => f.startsWith("instance-")).sort())
      .to.deep.equal(["instance-0", "instance-1"]);
    expect(execs).to.have.length(2);
  });

  it("gives each instance the shared identity", () => {
    config.testnet = "2";
    TestnetHandler.setup();
    for (const i of [0, 1]) {
      expect(
        fs.readFileSync(`instance-${i}/.identity`, "utf8")
      ).to.equal('{"shared":"identity"}');
    }
  });

  it("sets each instance up on its own port, in its own folder, without restore", () => {
    config.testnet = "3";
    TestnetHandler.setup();
    [5260, 5270, 5280].forEach((port, i) => {
      expect(execs[i].cmd).to.equal(
        `activeledger --port ${port} --data-dir .ds --setup-only --disable-autostart`
      );
      expect(execs[i].opts).to.deep.equal({ cwd: `instance-${i}` });
    });
  });

  it("stops each instance with SIGINT after its set up window", async () => {
    config.testnet = "2";
    TestnetHandler.setup();
    expect(execs.map((e) => e.killed)).to.deep.equal([[], []]);
    expect(timers).to.have.length(2);
    await finishInstances();
    expect(execs.slice(0, 2).map((e) => e.killed)).to.deep.equal([
      ["SIGINT"],
      ["SIGINT"],
    ]);
  });

  it("merges every instance config once all have been stopped", async () => {
    config.testnet = "3";
    TestnetHandler.setup();
    // Not before the instances are stopped
    await flush();
    expect(execs).to.have.length(3);
    await finishInstances();
    expect(execs).to.have.length(4);
    expect(execs[3].cmd).to.equal(
      'activeledger --merge "./instance-0/config.json" ' +
        '--merge "./instance-1/config.json" --merge "./instance-2/config.json"'
    );
  });

  it("writes a launcher that starts every instance, showing only the first", async () => {
    config.testnet = "3";
    TestnetHandler.setup();
    await finishInstances();
    expect(exits).to.equal(0);
    execs[3].handlers.exit();

    const launcher = fs.readFileSync("testnet", "utf8");
    const spawns = launcher.split("child.spawn(").slice(1);
    expect(spawns).to.have.length(3);
    spawns.forEach((s, i) => {
      expect(s).to.contain(`cwd: "instance-${i}"`);
      expect(s).to.contain(
        i === 0 ? 'stdio: "inherit"' : 'stdio: "ignore"'
      );
    });
    expect(launcher).to.match(/^let child = require\("child_process"\);/);
    expect(exits).to.equal(1);
  });

  it("exits without a launcher or merge when an instance cannot be created", async () => {
    config.testnet = "2";
    // instance-1 already exists, so mkdir fails for it
    fs.mkdirSync("instance-1");
    TestnetHandler.setup();
    await finishInstances();
    await flush();
    expect(exits).to.equal(1);
    expect(execs.some((e) => e.cmd.includes("--merge"))).to.equal(false);
    expect(fs.existsSync("testnet")).to.equal(false);
  });
});
