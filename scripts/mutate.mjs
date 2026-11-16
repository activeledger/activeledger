#!/usr/bin/env node
/**
 * A small mutation tester: does the test suite notice when the code is
 * broken on purpose?
 *
 *   npm run mutate -- <source file> [--lines 100-180,200] [--tests a.test.ts b.test.ts]
 *
 * For one source file it makes one small change at a time (=== to !==, && to
 * ||, > to >=, true to false, a return value dropped, and so on), runs the
 * tests against that single change, and reports the changes the tests did NOT
 * notice (survivors). A survivor is either a missing test or a change that
 * makes no difference (an "equivalent" mutant: a log line, a constant that is
 * the same either way). Real gaps get a test; equivalent ones go in
 * scripts/mutation-equivalents.json with a reason so they stop being reported.
 *
 * Safe by construction: it works in a throwaway git worktree under the OS temp
 * directory (your working tree is never touched, so a killed run cannot leave a
 * mutated file behind). It starts from HEAD and copies over the working-tree
 * version of the source file, the tests and tests/helpers, so uncommitted work
 * is what is tested.
 *
 * Tests that exercise code from OTHER packages load that package's BUILT lib:
 * run `npm run build` first, and for a mutation inside a package that tests
 * reach through its lib (not its src) mutate and rebuild accordingly. Tests
 * that import `../packages/<pkg>/src/...` directly (most unit tests) need
 * nothing extra.
 *
 * Options
 *   --lines 10-40,55   only mutate these lines (re-run just the survivors)
 *   --tests <files>    test files to run (default: every tests/*.test.ts that
 *                      imports the source file's module name)
 *   --rebuild <pkg>    for code the tests reach only through the package's BUILT
 *                      lib, such as storage's selfhost.ts, which the tests run as
 *                      its own process: give the package folder name (storage)
 *                      and the mutated source is compiled into the throwaway
 *                      tree's own lib before each mutant. A mutant that does
 *                      not compile counts as caught. Slower: one tsc per mutant.
 *   --timeout <sec>    per-mutant limit, a timeout counts as caught (default 90)
 *   --list             print the mutants and exit without running tests
 *
 * Output: a summary on stdout and every result in .mutation/<file>.jsonl.
 * Exit code 0 always; this is a report, not a gate.
 *
 * Runs take minutes to tens of minutes for a large file; it is not part of CI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : i;
};
const valueOf = (name) => {
  const i = flag(name);
  return i === -1 || i === undefined ? undefined : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--lines", "--timeout", "--rebuild"].includes(args[i - 1])) && !a.endsWith(".test.ts"));
if (!file) {
  console.error("usage: npm run mutate -- <source file> [--lines 100-180] [--tests a.test.ts ...] [--rebuild <package>] [--timeout 90] [--list]");
  process.exit(2);
}
const timeoutMs = Number(valueOf("--timeout") || 90) * 1000;
const rebuildPkg = valueOf("--rebuild");
const rel = path.relative(repo, path.resolve(repo, file));
if (!fs.existsSync(path.join(repo, rel))) {
  console.error(`No such file: ${rel}`);
  process.exit(2);
}

// ---- tests to run
let tests = [];
const t = flag("--tests");
if (t !== undefined) {
  for (const a of args.slice(t + 1)) {
    if (a.startsWith("--")) break;
    tests.push(a);
  }
} else {
  const module = path.basename(rel).replace(/\.ts$/, "");
  tests = fs
    .readdirSync(path.join(repo, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => new RegExp(`/${module}["']`).test(fs.readFileSync(path.join(repo, "tests", f), "utf8")))
    .map((f) => `tests/${f}`);
}
if (!tests.length) {
  console.error("No test files found that import this module; pass them with --tests.");
  process.exit(2);
}

// ---- mutants
const OPS = [
  ["===", "!==", "=== -> !=="],
  ["!==", "===", "!== -> ==="],
  ["&&", "||", "&& -> ||"],
  ["\\|\\|", "&&", "|| -> &&"],
  [">=", ">", ">= -> >"],
  ["(?<![=>-])>(?![=>])", ">=", "> -> >="],
  ["<=", "<", "<= -> <"],
  ["(?<![<=])<(?![<=])", "<=", "< -> <="],
  ["\\btrue\\b", "false", "true -> false"],
  ["\\bfalse\\b", "true", "false -> true"],
  ["(?<![!=])!(?![=])(?=[\\w(])", "", "remove !"],
  ["Math\\.max", "Math.min", "max -> min"],
  ["\\+\\+", "--", "++ -> --"],
  ["\\breturn ([^;]+);", "return undefined;", "return value -> undefined"],
  ["\\bcontinue;", "break;", "continue -> break"],
  ["\\?\\? ", "|| ", "?? -> ||"],
];
const original = fs.readFileSync(path.join(repo, rel), "utf8");
const lines = original.split("\n");
let mutants = [];
let inBlock = false;
lines.forEach((line, i) => {
  const trimmed = line.trim();
  if (inBlock) {
    if (trimmed.includes("*/")) inBlock = false;
    return;
  }
  if (trimmed.startsWith("/*")) {
    if (!trimmed.includes("*/")) inBlock = true;
    return;
  }
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed === "" || /^(import|export \{|export \*)/.test(trimmed)) return;
  const code = line.replace(/\/\/.*$/, "");
  for (const [src, rep, label] of OPS) {
    const re = new RegExp(src, "g");
    let m;
    while ((m = re.exec(code))) {
      // Not inside a string
      const quotes = (code.slice(0, m.index).match(/(?<!\\)["'`]/g) || []).length;
      if (quotes % 2 === 1) continue;
      const replaced = label === "return value -> undefined" ? rep : code.slice(m.index, m.index + m[0].length).replace(new RegExp(src), rep);
      const mutatedLine = code.slice(0, m.index) + replaced + code.slice(m.index + m[0].length) + line.slice(code.length);
      if (mutatedLine !== line) mutants.push({ line: i + 1, label, text: trimmed, mutatedLine });
    }
  }
});
const l = valueOf("--lines");
if (l) {
  const ranges = l.split(",").filter(Boolean).map((r) => r.split("-").map(Number));
  mutants = mutants.filter((mu) => ranges.some(([a, b]) => mu.line >= a && mu.line <= (b || a)));
}
console.log(`${rel}: ${mutants.length} mutants, ${tests.length} test file(s)`);
if (flag("--list") !== undefined) {
  for (const mu of mutants) console.log(`${mu.line}\t${mu.label}\t${mu.text}`);
  process.exit(0);
}

// ---- known equivalents
const equivalentsPath = path.join(repo, "scripts", "mutation-equivalents.json");
const equivalents = fs.existsSync(equivalentsPath) ? JSON.parse(fs.readFileSync(equivalentsPath, "utf8")) : [];
const isKnown = (mu) => equivalents.find((e) => e.file === rel && e.label === mu.label && e.text === mu.text);

// ---- throwaway worktree
const work = fs.mkdtempSync(path.join(os.tmpdir(), "al-mutate-"));
const tree = path.join(work, "tree");
const cleanup = () => {
  try {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo, stdio: "ignore" });
  } catch {
    // already gone
  }
  fs.rmSync(work, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(1);
  });
}
execFileSync("git", ["worktree", "add", "--detach", tree, "HEAD"], { cwd: repo, stdio: "ignore" });
const link = (from, to) => {
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to);
};
link(path.join(repo, "node_modules"), path.join(tree, "node_modules"));
for (const pkg of fs.readdirSync(path.join(repo, "packages"))) {
  link(path.join(repo, "packages", pkg, "node_modules"), path.join(tree, "packages", pkg, "node_modules"));
  // built libs, for tests that reach other packages through them. The one
  // being rebuilt is a real copy, so each mutant can be compiled into it
  if (pkg === rebuildPkg) {
    const built = path.join(repo, "packages", pkg, "lib");
    if (fs.existsSync(built)) fs.cpSync(built, path.join(tree, "packages", pkg, "lib"), { recursive: true });
  } else {
    link(path.join(repo, "packages", pkg, "lib"), path.join(tree, "packages", pkg, "lib"));
  }
}
// Working tree wins over HEAD
for (const p of [...tests, "tests/helpers", "tests/network"]) {
  const from = path.join(repo, p);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(tree, p), { recursive: true });
}

if (rebuildPkg && !fs.existsSync(path.join(repo, "packages", rebuildPkg))) {
  console.error(`No such package for --rebuild: ${rebuildPkg}`);
  cleanup();
  process.exit(2);
}
// Compile the tree's copy of the package into its own lib. False when it does not compile
const rebuild = () => {
  if (!rebuildPkg) return true;
  const r = spawnSync("npx", ["tsc", "--outDir", "lib", "--module", "commonjs"], { cwd: path.join(tree, "packages", rebuildPkg), encoding: "utf8", timeout: 300000 });
  return r.status === 0;
};

const target = path.join(tree, rel);
fs.writeFileSync(target, original);
const out = path.join(repo, ".mutation", `${rel.replace(/[\\/]/g, "__")}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "");

let killed = 0;
const survivors = [];
try {
  // The unmutated code must pass, or every mutant would look caught
  if (!rebuild()) {
    console.error("The package does not compile on the unmutated code; fix that first.");
    process.exitCode = 1;
    throw new Error("unmutated build failed");
  }
  const base = spawnSync("npx", ["mocha", "--node-option", "import=tsx", ...tests, "--exit", "--bail"], { cwd: tree, encoding: "utf8", timeout: 600000 });
  if (base.status !== 0) {
    console.error("The tests fail on the unmutated code; fix that first.\n" + (base.stdout || "").split("\n").slice(-25).join("\n"));
    process.exitCode = 1;
  } else {
    for (const [n, mu] of mutants.entries()) {
      const copy = lines.slice();
      copy[mu.line - 1] = mu.mutatedLine;
      fs.writeFileSync(target, copy.join("\n"));
      // A mutant that does not compile is caught: it could never be shipped
      const r = rebuild()
        ? spawnSync("npx", ["mocha", "--node-option", "import=tsx", ...tests, "--exit", "--bail"], { cwd: tree, timeout: timeoutMs, encoding: "utf8" })
        : { status: 1 };
      const caught = r.error || r.status !== 0;
      const known = !caught && isKnown(mu);
      caught ? killed++ : survivors.push({ ...mu, known: !!known });
      fs.appendFileSync(out, JSON.stringify({ line: mu.line, label: mu.label, status: caught ? "killed" : known ? "equivalent" : "SURVIVED", was: mu.text, now: mu.mutatedLine.trim() }) + "\n");
      if ((n + 1) % 20 === 0) console.log(`${n + 1}/${mutants.length} caught=${killed} survived=${survivors.length}`);
    }
    const open = survivors.filter((s) => !s.known);
    console.log(`\n${rel}: ${mutants.length} mutants, ${killed} caught, ${survivors.length - open.length} known equivalent, ${open.length} to look at`);
    for (const s of open) console.log(`  ${s.line}\t${s.label}\t${s.text.slice(0, 110)}`);
    console.log(`results: ${path.relative(repo, out)}`);
  }
} catch (e) {
  if (!String(e?.message).includes("unmutated build failed")) throw e;
} finally {
  cleanup();
}
