/**
 * Live check of the commands that start, end and look after a node:
 *
 *  - `--assert` runs once and exits, and leaves the running node's pid alone,
 *    so `status` and `stop` still find it
 *  - `--merge` with one file says what it needs instead of crashing
 *  - `activerestore --full` is a job: it ends, with a failing code when it
 *    cannot do its work
 *  - Ctrl+C ends the node and the database and restore processes with it
 *
 * Run via `npm run test:network:lifecycle`.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, spawnSync } from "child_process";
import { Report } from "./report";

const root = path.join(__dirname, "..", "..");
const ledger = path.join(root, "packages", "activeledger", "lib", "index.js");
const restore = path.join(root, "packages", "restore", "lib", "index.js");
const PORT = 5810;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = async (cond: () => boolean, tries = 100) => {
  for (let i = 0; i < tries && !cond(); i++) await sleep(200);
  return cond();
};

async function main(): Promise<boolean> {
  const report = new Report();
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-lifecycle-"));
  const run = (args: string[], timeout = 60000) =>
    spawnSync(process.execPath, [ledger, ...args], { cwd: dir, encoding: "utf8", timeout });
  const pids = (): any => JSON.parse(fs.readFileSync(path.join(dir, ".PID"), "utf8"));

  report.phase("Setting up one node");
  const setup = run(["--setup-only", "--port", String(PORT)]);
  check(setup.status === 0, "--setup-only wrote the node's files");

  report.phase("--merge with one file");
  const merge = run(["--merge", "config.json"]);
  check(merge.status === 1 && /needs two or more/.test(merge.stdout + merge.stderr), "says it needs two or more files and exits 1");

  report.phase("A stop signal while the node is still starting");
  const early = spawn(process.execPath, [ledger], { cwd: dir, stdio: "ignore" });
  await settle(() => {
    try {
      return !!pids().activestorage;
    } catch {
      return false;
    }
  }, 100);
  const earlyPids = pids();
  early.kill("SIGINT");
  check(await settle(() => !alive(earlyPids.activeledger), 60), "the node ends");
  check(await settle(() => !alive(earlyPids.activestorage), 30), "and its database with it");

  report.phase("Starting the node");
  const node = spawn(process.execPath, [ledger], { cwd: dir, stdio: "ignore" });
  const ready = await settle(() => {
    const s = run(["status", "--json"], 20000);
    return /"ready":\s*true/.test(s.stdout);
  }, 150);
  check(ready, "the node is ready");
  await sleep(8000); // listening, so the real handlers are in place
  const before = pids();
  report.info(`pids: ledger ${before.activeledger}, storage ${before.activestorage}, restore ${before.activerestore}`);

  try {
    report.phase("--assert");
    const started = Date.now();
    const assert = run(["--assert"], 60000);
    // One node has no neighbours to assert with, so it may say it cannot; what
    // matters is that it ends instead of hanging
    check(assert.status !== null, `ends instead of hanging (exit ${assert.status}, took ${Date.now() - started}ms)`);
    check(pids().activeledger === before.activeledger, "the running node's pid in .PID is unchanged");
    const status = run(["status", "--json"]);
    check(/"ready":\s*true/.test(status.stdout), "status still finds the node");

    report.phase("activerestore --full that cannot do its work");
    const full = spawnSync(process.execPath, [restore, "--full"], { cwd: dir, encoding: "utf8", timeout: 60000 });
    check(full.status === 1, `ends with 1 instead of staying up (exit ${full.status}, signal ${full.signal})`);

    report.phase("Ctrl+C");
    const kids = pids();
    // The node's workers are its children
    const workers = spawnSync("pgrep", ["-P", String(kids.activeledger)], { encoding: "utf8" }).stdout
      .split("\n").map(Number).filter((n) => n && n !== kids.activestorage && n !== kids.activerestore);
    report.info(`${workers.length} worker process(es) before`);
    process.kill(kids.activeledger, "SIGINT");
    const gone = await settle(() => !alive(kids.activeledger), 60);
    check(gone, "the node ends");
    check(await settle(() => !alive(kids.activestorage), 30), "and the database with it");
    check(await settle(() => !alive(kids.activerestore), 30), "and the restore engine with it");
    check(workers.length > 0 && (await settle(() => workers.every((w) => !alive(w)), 30)), "and its workers with it");
    const stop = run(["stop"]);
    check(!/ESRCH/.test(stop.stdout + stop.stderr), "a stop afterwards does not report an error");

    report.phase("activerestore --full with the node's database not running");
    // A node that was set up but never started has no database running
    const idle = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-lifecycle-idle-"));
    spawnSync(process.execPath, [ledger, "--setup-only", "--port", String(PORT + 40)], { cwd: idle, encoding: "utf8", timeout: 60000 });
    const noDb = spawnSync(process.execPath, [restore, "--full"], { cwd: idle, encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    fs.rmSync(idle, { recursive: true, force: true });
    check(noDb.status === 1, `ends with 1 (exit ${noDb.status})`);
    check(/database cannot be reached/.test(noDb.stdout + noDb.stderr), "and says the database cannot be reached");

    report.phase("restart");
    let out = "";
    const restarted = spawn(process.execPath, [ledger, "restart"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    restarted.stdout.on("data", (d) => (out += d));
    restarted.stderr.on("data", (d) => (out += d));
    await settle(() => /Boot Process Started/.test(out), 100);
    check(/Boot Process Started @ Version v?\d+\.\d+\.\d+/.test(out), "reports its version, not undefined");
    const upPids = pids();
    restarted.kill("SIGINT");
    await settle(() => !alive(upPids.activeledger), 60);
    await settle(() => !alive(upPids.activestorage), 30);
  } finally {
    node.kill("SIGKILL");
    const left = (() => {
      try {
        return pids();
      } catch {
        return {};
      }
    })();
    for (const pid of [left.activeledger, left.activestorage, left.activerestore]) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nLIFECYCLE CHECK PASSED\n" : "\nLIFECYCLE CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
