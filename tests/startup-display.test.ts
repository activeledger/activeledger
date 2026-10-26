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

  it("says once that a step is slow, and never redraws a line", async () => {
    const { d, out } = make({ slowAfterMs: 20 });
    d.begin("config");
    await new Promise((r) => setTimeout(r, 120));
    d.done();
    expect(out()).to.contain("[   ]   config  ...\n[###]   config\n");
    expect(out()).to.not.match(/\r|\u001b/);
    d.finish();
  });

  it("does not mention a step that finishes quickly while it runs", () => {
    const { d, out } = make({ slowAfterMs: 60000 });
    d.begin("config");
    d.done();
    expect(out()).to.not.contain("...");
    d.finish();
  });

  it("shows lag and cursor while catching up, a line at most every couple of seconds", () => {
    const { d, out } = make();
    d.begin("config");
    d.catchUp(12.4, "umid:100,abc");
    d.catchUp(11.9, "umid:101,abd");
    // The second call only updates what the next line will say
    expect(d.render()).to.contain("12s behind  umid:101,abd");
    expect(out()).to.contain("12s behind  umid:100,abc");
    expect(out().match(/s behind/g)).to.have.length(1);
    d.finish();
  });

  it("fills every block on finish and then stops writing", () => {
    const { d, out } = make();
    d.begin("config");
    d.finish();
    expect(d.render()).to.equal("[###]==[###]==[###]==[###]   ready");
    const len = out().length;
    d.begin("identity");
    d.progress("x");
    expect(out().length).to.equal(len);
  });

  it("writes log lines as they are, whole, on their own line", () => {
    const { d, out } = make();
    d.begin("config");
    d.log("INFO hello");
    expect(out().endsWith("INFO hello\n")).to.equal(true);
    d.finish();
  });

  it("breaks the chain on the rare roll, on that step's line only", () => {
    const { d, out } = make({ env: { ...tty, random: () => 0.01 } });
    d.begin("config");
    d.done();
    d.begin("identity");
    expect(d.render()).to.contain("=/=");
    d.done();
    d.begin("database");
    expect(d.render()).to.contain("=/=");
    d.done();
    expect(out().match(/=\/=/g)!.length).to.be.greaterThan(0);
    d.finish();
    const calm = make();
    calm.d.begin("config"); calm.d.done(); calm.d.begin("identity"); calm.d.done();
    expect(calm.out()).to.not.contain("=/=");
    calm.d.finish();
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

  it("opens with the banner: the linked blocks, name and version, and a tagline", () => {
    const { out } = make();
    expect(out()).to.match(/^ \[###\]==\[###\]==\[###\]\n   activeledger 5\.1\.0\n   .+\n\n/);
  });
});
