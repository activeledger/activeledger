/**
 * Live test of turning hybrids on and of `activeledger reload`: boots a
 * 3-supernode network at the default build with NO hybrid section, asserts
 * it, and checks that
 *  - `hybrid status` says hybrids are off and commits keep no attestation
 *    facts (nothing is signed for a network that has no hybrids);
 *  - `hybrid enable` (signed by a majority, as for the other hybrid changes)
 *    turns it on for every node without a restart, and later commits do keep
 *    the facts, signed with the Ed25519 key the nodes list;
 *  - enabling again is a no-op, and `activeledger reload` re-reads the config
 *    of a running node, which keeps serving.
 * Not a Mocha suite - run via `npm run test:network:hybrid-enable`.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet } from "./http";
import { Report } from "./report";
import { onboard } from "./actions";

const LEDGER = path.resolve(__dirname, "../../packages/activeledger/lib/index.js");

function run(args: string[], cwd: string, timeoutMs = 30000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LEDGER, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60000, every = 300): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** The `umid:` index rows of a node's events database, with whether each carries attestation facts */
async function indexRows(storageUrl: string): Promise<{ id: string; facts: boolean }[]> {
  const r = await requestJson(`${storageUrl}/activeledgerevents/_all_docs`, "GET");
  const ids = ((r.rows || []) as any[]).map((x) => String(x._id ?? x.id)).filter((id) => id.startsWith("umid:"));
  return Promise.all(
    ids.map(async (id) => ({ id, facts: !!(await storageGet(storageUrl, id, "activeledgerevents")).revsOut }))
  );
}

async function main(): Promise<boolean> {
  const report = new Report();
  // remote: so `activeledger reload` is allowed; no `hybrid` section, no `build`: the defaults
  const harness = new NetworkHarness({ nodeCount: 3, basePort: 5710, config: { remote: true }, readyTimeoutMs: 40000 });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };

  try {
    report.phase("Booting 3 supernodes with the default config");
    const nodes = await harness.start();
    const cfg0 = JSON.parse(fs.readFileSync(path.join(nodes[0].dataDir, "config.json"), "utf8"));
    check(cfg0.hybrid === undefined, "the default config has no hybrid section");
    report.ok(`build ${cfg0.build}`);

    report.phase("Asserting the network, restarting every node");
    await run(["--assert"], nodes[0].dataDir);
    for (let i = 0; i < nodes.length; i++) await harness.killNode(i);
    await Promise.all(nodes.map((_, i) => harness.restartNode(i)));
    await until("all nodes settled", async () => {
      const states = await Promise.all(nodes.map((n) => requestJson(`${n.baseUrl}/a/status`, "GET").catch(() => undefined)));
      return states.every((s) => s?.status === 4) ? true : undefined;
    }, 60000);

    report.phase("Hybrids are off");
    const off = await run(["hybrid", "status"], nodes[0].dataDir);
    check(off.code === 0 && /not enabled/.test(off.out) && /not signing/.test(off.out), `status: ${off.out.trim().split("\n")[0]}`);
    await onboard(nodes[1].baseUrl);
    await until("the commit to be indexed", async () => ((await indexRows(nodes[0].storageUrl)).length ? true : undefined), 20000);
    const before = await indexRows(nodes[0].storageUrl);
    check(before.length > 0 && before.every((r) => !r.facts), `no attestation facts kept on ${before.length} commit(s)`);

    report.phase("Turning hybrids on");
    const file = path.join(harness.rootDir, "enable.json");
    const built = await run(["hybrid", "enable", "--out", file], nodes[0].dataDir);
    const signed = await run(["hybrid", "sign", file], nodes[1].dataDir);
    const sent = await run(["hybrid", "submit", file], nodes[0].dataDir);
    check(built.code === 0 && signed.code === 0 && sent.code === 0, `enable: ${sent.out.trim().split("\n").pop()}`);
    for (const [i, n] of nodes.entries()) {
      const on = await until(`node ${i} to report hybrids enabled`, async () => {
        const r = await run(["hybrid", "status"], n.dataDir);
        return /enabled on this network/.test(r.out) ? r : undefined;
      }, 45000, 1000);
      check(/allowlist/.test(on.out), `node ${i}: enabled, ${on.out.split("\n").find((l) => l.startsWith("admission"))?.replace(/\s+/g, " ")}`);
      check(/signs votes and attestations with ed25519/.test(on.out), `node ${i}: signs with its Ed25519 key`);
    }

    report.phase("Commits now keep what a hybrid needs");
    await onboard(nodes[2].baseUrl);
    const withFacts = await until("a commit with attestation facts", async () => {
      const rows = await indexRows(nodes[0].storageUrl);
      return rows.some((r) => r.facts) ? rows : undefined;
    }, 20000);
    check(withFacts.filter((r) => r.facts).length >= 1, `${withFacts.filter((r) => r.facts).length} commit(s) with facts, ${withFacts.filter((r) => !r.facts).length} from before`);

    report.phase("Enabling again, and reload");
    const again = await run(["hybrid", "enable"], nodes[0].dataDir);
    check(again.code === 0 && /already enabled/.test(again.out), `enable again: ${again.out.trim().split("\n")[0]}`);
    const reload = await run(["reload"], nodes[0].dataDir);
    check(reload.code === 0 && /reloaded config\.json/.test(reload.out), `reload: ${reload.out.trim().split("\n").pop()}`);
    await until("the node to serve after the reload", async () => {
      const s = await requestJson(`${nodes[0].baseUrl}/a/status`, "GET");
      return s?.status === 4 ? true : undefined;
    }, 150000, 3000);
    await onboard(nodes[0].baseUrl);
    report.ok("a transaction commits after the reload");
  } catch (e) {
    passed = false;
    report.fail(`aborted: ${(e as Error).message}`);
  } finally {
    await harness.stop();
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
