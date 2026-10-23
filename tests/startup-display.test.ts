import { expect } from "chai";
import "mocha";
import { StartupDisplay } from "../packages/options/src/startup";
import { CliProgram } from "../packages/options/src/cli";

const program: CliProgram = {
  name: "activeledger",
  version: "5.1.0",
  defaultCommand: "start",
  commands: [],
  flags: [],
};
const STEPS = ["config", "identity", "database", "ready"];
const tty = { isTTY: true, noColor: false, random: () => 0.5 };

const make = (opts: any = {}) => {
  let buf = "";
  const d = new StartupDisplay(program, STEPS, {
    out: { write: (s: string) => (buf += s) },
    env: tty,
    ...opts,
  });
  return { d, out: () => buf };
};

describe("Start-up display", () => {
  it("builds the chain one block per completed step", () => {
    const { d } = make();
    d.begin("config");
    expect(d.render()).to.equal("[   ]   config");
    d.done();
    d.begin("identity");
    expect(d.render()).to.equal("[###]==[   ]   identity");
    d.done();
    d.begin("database");
    d.done();
    expect(d.render()).to.equal("[###]==[###]==[###]   database");
    d.finish();
  });

  it("stops at a failing step, draws [ X ] and prints the reason", () => {
    const { d, out } = make();
    d.begin("config");
    d.done();
    d.begin("identity");
    d.fail("identity file unreadable");
    expect(d.render()).to.contain("[###]==[ X ]");
    expect(out()).to.contain("\nidentity file unreadable\n");
    d.begin("database");
    expect(d.render()).to.not.contain("database");
  });

  it("shows a spinner only in a slow step", () => {
    const fast = make({ spinnerAfterMs: 60000 });
    fast.d.begin("config");
    expect(fast.d.render()).to.contain("[   ]");
    const slow = make({ spinnerAfterMs: 0 });
    slow.d.begin("config");
    expect(slow.d.render()).to.match(/\[ [|/\\-] \]/);
    fast.d.finish();
    slow.d.finish();
  });

  it("shows lag and cursor while catching up", () => {
    const { d } = make();
    d.begin("config");
    d.catchUp(12.4, "umid:100,abc");
    expect(d.render()).to.contain("12s behind  umid:100,abc");
    d.finish();
  });

  it("fills every block on finish and then stops drawing", () => {
    const { d, out } = make();
    d.begin("config");
    d.finish();
    expect(d.render()).to.equal("[###]==[###]==[###]==[###]   ready");
    const len = out().length;
    d.begin("identity");
    d.progress("x");
    expect(out().length).to.equal(len);
  });

  it("prints log lines above the display and redraws it", () => {
    const { d, out } = make();
    d.begin("config");
    d.log("INFO hello");
    expect(out()).to.contain("INFO hello\n");
    expect(out().endsWith("[   ]   config")).to.equal(true);
    d.finish();
  });

  it("breaks the chain on the rare roll and mends it", async () => {
    const { d } = make({ env: { ...tty, random: () => 0.01 } });
    d.begin("config");
    d.done();
    d.begin("identity");
    expect(d.render()).to.contain("=/=");
    await new Promise((r) => setTimeout(r, 700));
    expect(d.render()).to.not.contain("=/=");
    d.finish();
  });

  for (const [name, opts] of [
    ["not a terminal", { env: { ...tty, isTTY: false } }],
    ["NO_COLOR", { env: { ...tty, noColor: true } }],
    ["--quiet", { quiet: true }],
    ["--json", { json: true }],
    ["a process manager", { managed: true }],
  ] as const) {
    it(`prints one plain line per step, no escape codes, for ${name}`, () => {
      const { d, out } = make(opts);
      d.begin("config");
      d.log("INFO a");
      d.done();
      d.begin("identity");
      d.fail("bad");
      expect(d.chain).to.equal(false);
      expect(out()).to.equal("INFO a\nok  config\nFAIL  identity: bad\n");
      expect(out()).to.not.match(/\u001b|\r/);
    });
  }
});
