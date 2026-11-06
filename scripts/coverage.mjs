#!/usr/bin/env node
/**
 * Test coverage of the runtime code in packages/<name>/src, measured with c8
 * (config in .c8rc.json: what is counted and, with reasons, what is not).
 *
 *   npm run coverage          the unit suite (npm test), about two minutes
 *   npm run coverage:full     the unit suite plus the live network suites, merged
 *
 * The live suites boot real nodes, which run the compiled packages/<name>/lib code
 * (the CLI, the storage process, the workers). c8 follows those child processes
 * and maps them back to the TypeScript through the source maps, so the entry
 * points that no unit test can load are counted when a live suite runs them.
 * That takes twenty minutes or more and wants a quiet machine; build first
 * (`npm run build`), because the live suites run the build.
 *
 * Output: a summary on the console, coverage/coverage-summary.json (per file)
 * and coverage/lcov.info.
 */
import { spawnSync } from "child_process";
import { rmSync } from "fs";

// Pinned, and not a devDependency: adding one means a lockfile change, and a
// lockfile out of step with package.json fails `npm ci` in CI.
const C8 = "c8@12.0.0";
const full = process.argv.includes("--full");

const UNIT = ["npx", "mocha", "--node-option", "import=tsx", "tests/*.ts", "--exit", "--", "--no-warnings"];
const LIVE = [
  "test:network",
  "test:network:pq",
  "test:network:contracts",
  "test:network:restore",
  "test:network:lifecycle",
  "test:network:restore:resume",
  "test:network:selfsign",
  "test:network:expiry",
  "test:network:hybrid",
];

rmSync("coverage", { recursive: true, force: true });

const run = (label, command, clean) => {
  console.log(`\n== coverage: ${label}`);
  const args = ["--yes", C8, ...(clean ? [] : ["--clean=false"]), "--reporter=none", "--", ...command];
  const r = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
};

const results = [["unit suite", run("unit suite", UNIT, true)]];
if (full) {
  for (const script of LIVE) results.push([script, run(script, ["npm", "run", script], false)]);
}

spawnSync("npx", ["--yes", C8, "report"], { stdio: "inherit", shell: process.platform === "win32" });

console.log("\nsuites run:");
for (const [name, ok] of results) console.log(`  ${ok ? "passed" : "FAILED"}  ${name}`);
// A failing suite still contributes what it covered, but is not a green run
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
