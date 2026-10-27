import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// docs/en-gb/cli.md and hybrid.md name flags and commands. A flag or command
// that the built programs do not list in --help is a claim the docs make that
// is false, so this fails when one is renamed or removed and the docs are not.
const root = path.join(__dirname, "..");
const help = (program: string) =>
  spawnSync(process.execPath, [path.join(root, program), "--help"], { encoding: "utf8" }).stdout;
const read = (file: string) => fs.readFileSync(path.join(root, "docs/en-gb", file), "utf8");

describe("The command line documentation matches the programs", () => {
  const ledgerHelp = help("packages/activeledger/lib/index.js");
  const hybridHelp = help("packages/hybrid/lib/index.js");
  const both = `${ledgerHelp}\n${hybridHelp}`;
  // The docs also cover flags of the other programs the help text lists
  const docs = { "cli.md": read("cli.md"), "hybrid.md": read("hybrid.md") };

  // cli.md uses a misspelt flag as its example of one that is refused
  const EXAMPLES = ["--assrt"];
  const flagsIn = (text: string): string[] =>
    [...new Set([...text.matchAll(/`(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))].filter((f) => !EXAMPLES.includes(f));

  for (const [file, text] of Object.entries(docs)) {
    it(`${file}: every flag it names is listed by --help`, () => {
      const missing = flagsIn(text).filter((f) => !new RegExp(`${f}(?![a-z-])`).test(both));
      expect(missing).to.deep.equal([]);
    });
  }

  it("hybrid.md: every activehybrid command it names is a command", () => {
    const named = [...docs["hybrid.md"].matchAll(/`activehybrid ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((c) => !new RegExp(`^  ${c}\\b`, "m").test(hybridHelp));
    expect(missing).to.deep.equal([]);
  });

  it("hybrid.md and cli.md: every `activeledger hybrid` subcommand is listed", () => {
    const text = `${docs["hybrid.md"]}\n${docs["cli.md"]}`;
    const named = [...text.matchAll(/`activeledger hybrid ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((c) => !new RegExp(`hybrid [^\\n]*\\b${c}\\b`).test(ledgerHelp));
    expect(missing).to.deep.equal([]);
  });

  it("cli.md: every command of the shared table is a command of both programs", () => {
    for (const c of ["start", "stop", "restart", "status", "check-config"]) {
      expect(ledgerHelp, `activeledger ${c}`).to.match(new RegExp(`^  ${c}\\b`, "m"));
      expect(hybridHelp, `activehybrid ${c}`).to.match(new RegExp(`^  ${c}\\b`, "m"));
    }
  });
});
