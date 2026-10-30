import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

// The built programs, run as an operator or a script would run them. The
// parser is unit tested in cli-layer.test.ts; this pins what a script sees:
// exit codes and what is printed, as cli.md and hybrid.md describe them.
// Needs `npm run build`, like the rest of the suite.
const root = path.join(__dirname, "..");
const programs = {
  hybrid: path.join(root, "packages/hybrid/lib/index.js"),
  ledger: path.join(root, "packages/activeledger/lib/index.js"),
};

describe("The built programs (command line smoke)", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-cli-smoke-"));
    fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ upstreams: [{ host: "h", port: 5260 }] }));
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ nope: 1 }));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (program: keyof typeof programs, ...args: string[]) => {
    const r = spawnSync(process.execPath, [programs[program], ...args], { cwd: dir, encoding: "utf8", timeout: 20000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  for (const program of ["hybrid", "ledger"] as const) {
    describe(program === "hybrid" ? "activehybrid" : "activeledger", () => {
      it("exits 1 on an unknown flag, naming it, before anything starts", () => {
        const r = run(program, "--bogus");
        expect(r.code).to.equal(1);
        expect(r.out).to.contain('Unknown flag "--bogus"');
      });
      it("exits 1 on an unknown command", () => {
        const r = run(program, "frobnicate");
        expect(r.code).to.equal(1);
        expect(r.out).to.contain('Unknown command "frobnicate"');
      });
      it("prints its version and exits 0", () => {
        const r = run(program, "version");
        expect(r.code).to.equal(0);
        expect(r.out).to.match(/v\d+\.\d+\.\d+/);
      });
      it("prints help that lists the shared commands and flags, and exits 0", () => {
        const r = run(program, "--help");
        expect(r.code).to.equal(0);
        for (const word of ["start", "stop", "restart", "status", "check-config", "--config", "--json", "--quiet", "--yes"]) {
          expect(r.out, word).to.contain(word);
        }
      });
      it("check-config exits 2 for a file it cannot read", () => {
        expect(run(program, "check-config", "--config", "missing.json").code).to.equal(2);
      });
    });
  }

  describe("activehybrid check-config", () => {
    it("exits 0 for a valid file and names the key at fault in an invalid one", () => {
      expect(run("hybrid", "check-config", "--config", "ok.json").code).to.equal(0);
      const bad = run("hybrid", "check-config", "--config", "bad.json");
      expect(bad.code).to.equal(2);
      expect(bad.out).to.contain("nope: unknown key");
    }).timeout(10000); // two child processes, which can pass 2s under load
  });

  describe("status with nothing running", () => {
    it("activeledger status exits 2 and says it is not running", () => {
      const r = run("ledger", "status", "--port", "59998");
      expect(r.code).to.equal(2);
      expect(r.out).to.contain("not running");
    });
    it("activehybrid status exits 2 against a valid config, with no node", () => {
      expect(run("hybrid", "status", "--config", "ok.json", "--port", "59999").code).to.equal(2);
    });
  });
});
