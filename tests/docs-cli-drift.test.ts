import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// The command line guide pages (docs/guide/cli, docs/guide/hybrid) name flags and commands. A flag or command
// that the built programs do not list in --help is a claim the docs make that
// is false, so this fails when one is renamed or removed and the docs are not.
const root = path.join(__dirname, "..");
const help = (program: string) =>
  spawnSync(process.execPath, [path.join(root, program), "--help"], { encoding: "utf8" }).stdout;
const tsFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []
  );
const read = (...files: string[]) => files.map((f) => fs.readFileSync(path.join(root, "docs/guide", f), "utf8")).join("\n");

describe("The command line documentation matches the programs", () => {
  const ledgerHelp = help("packages/activeledger/lib/index.js");
  const hybridHelp = help("packages/hybrid/lib/index.js");
  const both = `${ledgerHelp}\n${hybridHelp}`;
  // The docs also cover flags of the other programs the help text lists
  const docs = {
    "cli/activeledger.md + cli/activerestore.md": read("cli/activeledger.md", "cli/activerestore.md"),
    "cli/activehybrid.md + hybrid/": read("cli/activehybrid.md", "hybrid/index.md", "hybrid/operate.md", "hybrid/run.md"),
  };
  const ledgerDocs = docs["cli/activeledger.md + cli/activerestore.md"];
  const hybridDocs = docs["cli/activehybrid.md + hybrid/"];

  // the CLI page uses a misspelt flag as its example of one that is refused
  const EXAMPLES = ["--assrt"];
  const flagsIn = (text: string): string[] =>
    [...new Set([...text.matchAll(/`(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))].filter((f) => !EXAMPLES.includes(f));

  // activerestore, and flags of the hybrid, are not in either --help text, so a flag
  // also counts when its name still appears in the programs' own sources
  const sourceText = ["options", "restore", "hybrid", "activeledger"]
    .flatMap((pkg) => tsFiles(path.join(root, "packages", pkg, "src")))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const named = (flag: string, text: string) => new RegExp(`(?<![A-Za-z0-9-])${flag.slice(2)}(?![A-Za-z0-9-])`).test(text);

  for (const [file, text] of Object.entries(docs)) {
    it(`${file}: every flag it names is listed by --help or exists in the programs`, () => {
      const missing = flagsIn(text).filter((f) => !new RegExp(`${f}(?![a-z-])`).test(both) && !named(f, sourceText));
      expect(missing).to.deep.equal([]);
    });
  }

  it("the hybrid pages: every activehybrid command they name is a command", () => {
    const named = [...hybridDocs.matchAll(/`activehybrid ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((c) => !new RegExp(`^  ${c}\\b`, "m").test(hybridHelp));
    expect(missing).to.deep.equal([]);
  });

  it("the guide: every `activeledger hybrid` subcommand named is listed", () => {
    const text = `${hybridDocs}\n${ledgerDocs}`;
    const named = [...text.matchAll(/`activeledger hybrid ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((c) => !new RegExp(`hybrid [^\\n]*\\b${c}\\b`).test(ledgerHelp));
    expect(missing).to.deep.equal([]);
  });

  it("every command of the shared set is a command of both programs", () => {
    for (const c of ["start", "stop", "restart", "status", "check-config"]) {
      expect(ledgerHelp, `activeledger ${c}`).to.match(new RegExp(`^  ${c}\\b`, "m"));
      expect(hybridHelp, `activehybrid ${c}`).to.match(new RegExp(`^  ${c}\\b`, "m"));
    }
  });
});
