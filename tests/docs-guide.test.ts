import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// The guide in docs/guide is published as a site. These checks keep it honest
// without needing MkDocs: every page in the nav exists, every page is in the
// nav, every link lands somewhere, the commands it names are real, and it
// carries nothing it should not.
const root = path.join(__dirname, "..");
const guide = path.join(root, "docs", "guide");

const pagesOnDisk = (dir = guide): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pagesOnDisk(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.relative(guide, path.join(dir, e.name))] : []
  );

const navPages = (): string[] =>
  [...fs.readFileSync(path.join(root, "mkdocs.yml"), "utf8").matchAll(/:\s+([\w/-]+\.md)\s*$/gm)].map((m) => m[1]);

const read = (page: string) => fs.readFileSync(path.join(guide, page), "utf8");
const run = (program: string, args: string[]) =>
  spawnSync(process.execPath, [path.join(root, program), ...args], { encoding: "utf8" }).stdout;
// The program's own help plus the help of every command it lists, because
// some flags (--timeout, --foreground) are only listed under their command
const help = (program: string) => {
  const top = run(program, ["--help"]);
  const commands = [...new Set([...top.matchAll(/^  ([a-z][a-z-]*)\b/gm)].map((m) => m[1]))];
  return [top, ...commands.map((c) => run(program, ["help", c]))].join("\n");
};

describe("The guide (docs/guide)", () => {
  const disk = pagesOnDisk();
  const nav = navPages();

  it("every page in the nav exists", () => {
    expect(nav.filter((p) => !disk.includes(p))).to.deep.equal([]);
  });

  it("every page is in the nav", () => {
    expect(disk.filter((p) => !nav.includes(p))).to.deep.equal([]);
  });

  it("every relative link lands on a page, and every anchor on a heading", () => {
    const broken: string[] = [];
    for (const page of disk) {
      for (const m of read(page).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const [file, anchor] = target.split("#");
        const resolved = path.normalize(path.join(path.dirname(page), file));
        if (!disk.includes(resolved)) {
          broken.push(`${page} -> ${target}`);
          continue;
        }
        if (anchor) {
          const slugs = [...read(resolved).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((h) =>
            h[1].toLowerCase().replace(/[`*_]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")
          );
          if (!slugs.includes(anchor)) broken.push(`${page} -> ${target}`);
        }
      }
    }
    expect(broken).to.deep.equal([]);
  });

  it("every page starts with a title", () => {
    expect(disk.filter((p) => !/^# \S/.test(read(p)))).to.deep.equal([]);
  });

  it("carries no placeholder text and no tool or author attribution", () => {
    const found: string[] = [];
    for (const page of disk) {
      const text = read(page);
      for (const re of [/\bTODO\b/, /\bTBD\b/, /coming soon/i, /\bClaude\b/, /Anthropic/, /Co-Authored-By/i, /Generated with/i]) {
        if (re.test(text)) found.push(`${page}: ${re}`);
      }
    }
    expect(found).to.deep.equal([]);
  });

  describe("the command line pages match the programs", () => {
    const programs: [string, string][] = [
      ["cli/activeledger.md", "packages/activeledger/lib/index.js"],
      ["cli/activehybrid.md", "packages/hybrid/lib/index.js"],
      ["cli/activerestore.md", "packages/restore/lib/index.js"],
    ];
    // activerestore has no --help, so its flags are checked against its source
    const restoreSource = (): string => {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []
        );
      return walk(path.join(root, "packages", "restore", "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    };
    for (const [page, program] of programs) {
      it(`${page}: every flag it names exists`, function () {
        this.timeout(60000);
        const text = program.includes("restore") ? [...restoreSource().matchAll(/["'`]([a-z][a-z-]*)["'`]/g)].map((m) => "--" + m[1]).join(" ") : help(program);
        // --help is named on the activerestore page only to say it does not exist
        const flags = [...new Set([...read(page).matchAll(/`(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))].filter((f) => f !== "--help");
        const missing = flags.filter((f) => !new RegExp(`${f}(?![a-z-])`).test(text));
        expect(missing).to.deep.equal([]);
      });
    }
  });
});
