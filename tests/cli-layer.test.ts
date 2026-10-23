import { expect } from "chai";
import "mocha";
import {
  CliProgram,
  COMMON_COMMANDS,
  COMMON_FLAGS,
  ExitCode,
  banner,
  helpText,
  parseCli,
  runCli,
} from "../packages/options/src/cli";

const program: CliProgram = {
  name: "activeledger",
  version: "5.1.0",
  defaultCommand: "start",
  commands: COMMON_COMMANDS,
  flags: [
    ...COMMON_FLAGS,
    { name: "stop", type: "boolean", command: "stop", description: "Alias of stop" },
    { name: "assert", description: "Assert config" },
    { name: "testnet", description: "Build a testnet" },
  ],
};

const tty = { isTTY: true, noColor: false, random: () => 0.5 };

describe("Shared CLI layer (options)", () => {
  it("defaults to start with no arguments", () => {
    expect(parseCli(program, []).command).to.equal("start");
  });

  it("treats a legacy flag as its command", () => {
    const p = parseCli(program, ["--stop"]);
    expect(p.command).to.equal("stop");
    expect(p.errors).to.deep.equal([]);
  });

  it("accepts every existing flag unchanged, with and without values", () => {
    const p = parseCli(program, ["--assert", "--port", "5261", "--data-dir", "x", "--testnet"]);
    expect(p.errors).to.deep.equal([]);
    expect(p.flags.port).to.equal(5261);
  });

  it("stops on an unknown flag and suggests the nearest", () => {
    const p = parseCli(program, ["--assrt"]);
    expect(p.errors[0]).to.contain('Unknown flag "--assrt"').and.contain('"--assert"');
  });

  it("stops on an unknown command and suggests the nearest", () => {
    const p = parseCli(program, ["stauts"]);
    expect(p.errors[0]).to.contain('Unknown command "stauts"').and.contain('"status"');
  });

  it("does not let a boolean flag swallow the command", () => {
    const p = parseCli(program, ["--json", "status"]);
    expect(p.command).to.equal("status");
    expect(p.flags.json).to.equal(true);
  });

  it("only accepts a command's own flags on that command", () => {
    expect(parseCli(program, ["status", "--max-lag", "5"]).errors).to.deep.equal([]);
    expect(parseCli(program, ["stop", "--max-lag", "5"]).errors).to.have.length(1);
  });

  it("accepts -v as version", () => {
    expect(parseCli(program, ["-v"]).command).to.equal("version");
  });

  describe("runCli", () => {
    const run = (argv: string[]) => {
      let out = "";
      let err = "";
      const r = runCli(program, argv, tty, (s, e) => (e ? (err += s) : (out += s)));
      return { r, out, err };
    };

    it("exits 1 before anything starts on an unknown flag", () => {
      const { r, err } = run(["--assrt"]);
      expect(r.exit).to.equal(ExitCode.FAIL);
      expect(err).to.contain("help");
    });

    it("lets a normal start through", () => {
      expect(run([]).r.exit).to.equal(undefined);
    });

    it("prints help for the program and for one command", () => {
      expect(run(["--help"]).out).to.contain("Commands:");
      const one = run(["help", "status"]);
      expect(one.out).to.contain("--max-lag").and.not.contain("[###]");
      expect(one.r.exit).to.equal(0);
    });

    it("prints the version, as JSON on request", () => {
      expect(run(["version"]).out).to.equal("v5.1.0\n");
      expect(JSON.parse(run(["--json", "version"]).out)).to.deep.equal({ version: "5.1.0" });
    });
  });

  describe("banner", () => {
    it("draws the chain on a terminal", () => {
      expect(banner(program, {}, tty)).to.contain("[###]==[###]==[###]");
    });

    it("draws a hollow last block for a hybrid", () => {
      expect(banner({ ...program, hollow: true }, {}, tty)).to.contain("[###]==[###]==[   ]");
    });

    it("breaks the chain on the rare roll", () => {
      expect(banner(program, {}, { ...tty, random: () => 0.01 })).to.contain("=/=");
    });

    it("is empty off a terminal, with NO_COLOR, --json or --quiet", () => {
      expect(banner(program, {}, { ...tty, isTTY: false })).to.equal("");
      expect(banner(program, {}, { ...tty, noColor: true })).to.equal("");
      expect(banner(program, { json: true }, tty)).to.equal("");
      expect(banner(program, { quiet: true }, tty)).to.equal("");
    });

    it("keeps escape codes out of help", () => {
      expect(helpText(program, undefined, {}, { ...tty, isTTY: false })).to.not.match(/\u001b|\[###\]/);
    });
  });
});
