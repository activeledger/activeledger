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

  it("draws one live line, rewritten in place: the running block animates and the seconds show once a step is slow", async () => {
    let t = 1000;
    const { d, out } = make({ tickMs: 15, now: () => t });
    d.begin("config");
    expect(out()).to.include("\r\u001b[2K[   ]   config");
    await new Promise((r) => setTimeout(r, 90));
    expect(out()).to.include("[.  ]   config").and.to.include("[.. ]   config");
    expect(out()).to.not.include("(");
    t += 4500;
    await new Promise((r) => setTimeout(r, 60));
    expect(out()).to.include("[...]   config  (4s)");
    // Only the live line moves: no newline was written for any repaint
    expect(out().replace(/^[\s\S]*\n\n/, "")).to.not.include("\n");
    d.done();
    expect(out().endsWith("\r\u001b[2K[###]   config")).to.equal(true);
    d.finish();
  });

  it("paints a step when it starts and again when it ends, and writes nothing between on a quick step", () => {
    const { d, out } = make({ tickMs: 60000 });
    const before = out().length;
    d.begin("config");
    d.done();
    const painted = out().slice(before);
    expect(painted.match(/\r\u001b\[2K/g)).to.have.length(2);
    expect(painted).to.not.include("\n");
    d.finish();
  });

  it("shows lag and cursor while catching up, repainted at most every 100ms", () => {
    let t = 0;
    const { d, out } = make({ now: () => t, tickMs: 60000 });
    d.begin("config");
    t += 200;
    d.catchUp(12.4, "umid:100,abc");
    t += 10;
    d.catchUp(11.9, "umid:101,abd");
    // The second call came too soon to paint; it only changes what the next paint says
    expect(d.render()).to.contain("12s behind  umid:101,abd");
    expect(out()).to.contain("12s behind  umid:100,abc");
    expect(out().match(/s behind/g)).to.have.length(1);
    t += 200;
    d.catchUp(11.5, "umid:102,abe");
    expect(out()).to.contain("12s behind  umid:102,abe");
    d.finish();
  });

  it("keeps the live line inside the terminal's width", () => {
    const { d, out } = make({ columns: 20, tickMs: 60000 });
    d.begin("config");
    d.progress("a very long piece of detail that would wrap the line");
    d.progress("another very long piece of detail that would wrap the line");
    for (const painted of out().split("\r\u001b[2K").slice(1)) expect(painted.length).to.be.lessThan(20);
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

  it("a log line clears the live line, prints whole on its own line, and the live line is drawn again beneath it", () => {
    const { d, out } = make({ tickMs: 60000 });
    d.begin("config");
    d.log("INFO hello");
    expect(out()).to.include("\r\u001b[2KINFO hello\n\r\u001b[2K[   ]   config");
    expect(out().endsWith("[   ]   config")).to.equal(true);
    d.finish();
    // With nothing live yet, a log line is just a line
    const quiet = make({ tickMs: 60000 });
    quiet.d.log("INFO early");
    expect(quiet.out().endsWith("INFO early\n")).to.equal(true);
    quiet.d.finish();
  });

  it("finish leaves the filled-in line, with how long it took, and a blank line", () => {
    let t = 0;
    const { d, out } = make({ now: () => t, tickMs: 60000 });
    d.begin("config");
    t = 3400;
    d.finish();
    expect(out().endsWith("\r\u001b[2K[###]==[###]==[###]==[###]   ready  (3.4s)\n\n")).to.equal(true);
  });

  it("a failure clears the live line and leaves the broken chain and the reason", () => {
    const { d, out } = make({ tickMs: 60000 });
    d.begin("config");
    d.done();
    d.begin("identity");
    d.fail("no identity file");
    expect(out().endsWith("\r\u001b[2K[###]==[ X ]   identity\nno identity file\n")).to.equal(true);
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

  it("opens with the banner: the logo joined to the name in letters, the version, and a tagline", () => {
    const { out } = make();
    expect(out()).to.match(/^ {4}\/\\ {6}#### [^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\/_\/ {4}\\_\\ [^\n]*\n\n {2}activeledger 5\.1\.0\n {2}.+\n\n/);
  });
});
