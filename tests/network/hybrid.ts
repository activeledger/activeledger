/**
 * Live hybrid integration test: boots a 3-supernode network (build 40300),
 * asserts it to the ledger, registers a hybrid, runs `activehybrid start`
 * against it and checks the hybrid follows the ledger: same streams at the
 * same revisions, no divergences, health ready, and a transaction submitted
 * through the hybrid commits with its `$relay`. Not a Mocha suite - run via
 * `npm run test:network:hybrid`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet, submit } from "./http";
import { Report } from "./report";
import { onboard, registerNamespace, deployContract, runContract, lockContract } from "./actions";
import { ActiveCrypto } from "../../packages/crypto/src";

const LEDGER = path.resolve(__dirname, "../../packages/activeledger/lib/index.js");
const HYBRID = path.resolve(__dirname, "../../packages/hybrid/lib/index.js");
const HYBRID_PORT = 5690;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(entry: string, args: string[], cwd: string, timeoutMs = 20000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
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
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

const health = async () => requestJson(`http://127.0.0.1:${HYBRID_PORT}/health`, "GET").catch(() => undefined);

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 3, basePort: 5610, config: {
      build: 40300,
      // The package is still 5.0.2 until the release bump, and the default
      // network minimum is 5.1.0, which a hybrid below it honours by staying idle
      hybrid: { admission: "open", required: [], window: { days: 30 }, minVersion: "5.0.0" },
    },
    readyTimeoutMs: 40000,
  });
  const hybridDir = fs.mkdtempSync(path.join(os.tmpdir(), "activehybrid-test-"));
  let hybrid: ChildProcess | undefined;
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };

  try {
    report.phase("Booting 3 supernodes at build 40300");
    const nodes = await harness.start();
    report.ok(`ready on ${nodes.map((n) => n.port).join(", ")}`);

    report.phase("Asserting the network to the ledger, restarting every node");
    const assertRun = await run(LEDGER, ["--assert"], nodes[0].dataDir, 30000);
    const cfg = JSON.parse(fs.readFileSync(path.join(nodes[0].dataDir, "config.json"), "utf8"));
    if (!check(!!cfg.network, `network asserted (${cfg.network ?? assertRun.out.slice(-300)})`)) throw new Error("assert failed");
    // The setup contract rewrites every node's config.json (they now share a
    // network id, which node references are computed from), so every node
    // restarts, or the ring would disagree about who is who
    for (let i = 0; i < nodes.length; i++) await harness.killNode(i);
    await Promise.all(nodes.map((_, i) => harness.restartNode(i)));
    await until("all nodes settled after the restart", async () => {
      const states = await Promise.all(nodes.map((n) => requestJson(`${n.baseUrl}/a/status`, "GET").catch(() => undefined)));
      return states.every((s) => s?.status === 4) ? true : undefined;
    }, 60000);
    report.ok("all nodes back up and paired");

    report.phase("Registering a hybrid");
    const init = await run(HYBRID, ["init", "--upstream", `127.0.0.1:${nodes[0].port}`, "--port", String(HYBRID_PORT)], hybridDir);
    check(init.code === 0, `init: ${init.out.trim().split("\n")[0]}`);
    const reg = await run(HYBRID, ["register", "--endpoint", `http://127.0.0.1:${HYBRID_PORT}`, "--label", "itest"], hybridDir);
    check(reg.code === 0, `register: ${reg.out.trim().split("\n").pop()}`);
    const regAgain = await run(HYBRID, ["register", "--endpoint", `http://127.0.0.1:${HYBRID_PORT}`], hybridDir);
    check(regAgain.code === 0 && /already registered/.test(regAgain.out), "register is idempotent");

    report.phase("Creating some ledger history before the hybrid starts");
    const identity = await onboard(nodes[1].baseUrl);
    const ns = await registerNamespace(nodes[1].baseUrl, identity, "hybridtest");
    check(!ns.$summary?.errors, `onboarded ${identity.streamId.slice(0, 12)}… and registered a namespace`);
    const contractId = await deployContract(nodes[1].baseUrl, identity, "hybridtest", "returner", path.join(__dirname, "contracts/returner-contract.ts"));
    report.ok(`contract deployed ${contractId.slice(0, 12)}…`);
    for (let i = 0; i < 3; i++) {
      const r = await runContract(nodes[i % 3].baseUrl, identity, "hybridtest", contractId, { message: `before-${i}` });
      if (r.$summary?.errors) throw new Error(`pre-history tx failed: ${JSON.stringify(r.$summary)}`);
    }
    report.ok("3 contract runs committed");

    report.phase("Starting the hybrid");
    const startOut = await run(HYBRID, ["start", "--quiet"], hybridDir, 120000);
    check(startOut.code === 0, `start exited ${startOut.code}: ${startOut.out.trim().split("\n").slice(-3).join(" | ")}`);
    const h0 = await until("hybrid ready", async () => {
      const h = await health();
      return h?.ready ? h : undefined;
    }, 60000);
    report.ok(`ready, cursor ${h0.cursor}, lag ${h0.lagSeconds}s`);

    report.phase("Hybrid matches the supernodes");
    const sameStream = async (id: string, label: string) => {
      const chain = await storageGet(nodes[0].storageUrl, id);
      const mine = await until(`${label} on hybrid`, async () => {
        const r = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/stream/${id}`, "GET").catch(() => undefined);
        return r?.stream ? r : undefined;
      }, 20000);
      check(mine.stream._rev === chain._rev, `${label}: hybrid _rev ${mine.stream._rev} == supernode ${chain._rev}`);
      check(JSON.stringify(mine.stream) === JSON.stringify(chain), `${label}: documents identical`);
    };
    await sameStream(identity.streamId, "identity stream");
    await sameStream(contractId, "contract stream");

    report.phase("Hybrid follows new transactions");
    const before = (await health()).cursor;
    for (let i = 0; i < 3; i++) {
      const r = await runContract(nodes[(i + 1) % 3].baseUrl, identity, "hybridtest", contractId, { message: `after-${i}` });
      if (r.$summary?.errors) throw new Error(`live tx failed: ${JSON.stringify(r.$summary)}`);
    }
    await until("hybrid to apply the new transactions", async () => {
      const h = await health();
      if (!h || h.cursor === before) return undefined;
      const chain = await storageGet(nodes[0].storageUrl, identity.streamId);
      const mine = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/stream/${identity.streamId}`, "GET");
      return mine.stream?._rev === chain._rev ? true : undefined;
    }, 40000);
    await sameStream(identity.streamId, "identity stream after new transactions");
    const div = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/divergences`, "GET");
    check(Array.isArray(div) && div.length === 0, `no divergences (${JSON.stringify(div).slice(0, 200)})`);

    report.phase("Transaction through the hybrid");
    const txBody = {
      $namespace: "hybridtest",
      $contract: contractId,
      $i: { [identity.streamId]: {} },
      $o: { [identity.streamId]: { message: "via-hybrid" } },
      $expire: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const viaHybrid = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/`, "POST", {
      $tx: txBody,
      $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
    });
    check(!viaHybrid.$hybrid && !viaHybrid.$summary?.errors && !!viaHybrid.$umid, `supernode answered unchanged ($umid ${String(viaHybrid.$umid).slice(0, 12)}…)`);
    if (viaHybrid.$umid) {
      const umidDoc = await until("umid doc on node 0", async () => {
        const d = await storageGet(nodes[0].storageUrl, `${viaHybrid.$umid}:umid`);
        return d?._id ? d : undefined;
      }, 20000);
      check(!!umidDoc.umid?.$relay?.key, "the stored transaction carries the hybrid's $relay");
    }
    const refused = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/`, "POST", {
      $tx: { $namespace: "default", $contract: "contract", $i: {}, $expire: new Date(Date.now() + 60000).toISOString() },
      $sigs: {},
    });
    check(refused.$hybrid === "denied", "a contract deploy is denied by the hybrid");

    report.phase("A locked contract version");
    const lockedTx = await lockContract(nodes[0].baseUrl, identity, "hybridtest", contractId, "0.0.1");
    check(!lockedTx.$summary?.errors, "the lock committed on the supernodes");
    await until("the hybrid to hold the lock", async () => {
      const r = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/stream/${contractId}`, "GET").catch(() => undefined);
      return r?.stream?.locks?.versions?.includes("0.0.1") ? true : undefined;
    }, 30000);
    await sameStream(contractId, "contract stream with its lock");
    const pinnedBody = {
      $namespace: "hybridtest",
      $contract: `${contractId}@=0.0.1`,
      $i: { [identity.streamId]: {} },
      $o: { [identity.streamId]: { message: "locked" } },
      $expire: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const pinned = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/`, "POST", {
      $tx: pinnedBody,
      $sigs: { [identity.streamId]: identity.keyPair.sign(pinnedBody) },
    });
    // The hybrid may refuse it itself or pass it on for a supernode to refuse;
    // what must never happen is that it commits
    check(!!pinned.$hybrid || !!pinned.$summary?.errors || pinned.$summary?.commit === 0, `a transaction pinned to the locked version does not commit (${JSON.stringify(pinned).slice(0, 160)})`);
    const unlocked = await lockContract(nodes[0].baseUrl, identity, "hybridtest", contractId, "0.0.1", "unlock");
    check(!unlocked.$summary?.errors, "the unlock committed");
    await until("the hybrid to drop the lock", async () => {
      const r = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/stream/${contractId}`, "GET").catch(() => undefined);
      return r?.stream && !r.stream.locks?.versions?.length ? true : undefined;
    }, 30000);
    await sameStream(contractId, "contract stream after the unlock");
    const divAfter = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/divergences`, "GET");
    check(Array.isArray(divAfter) && divAfter.length === 0, "no divergences from the lock changes");

    report.phase("Changing the hybrid rules on the ledger");
    // More than half of the nodes sign: node 0 builds and signs, node 1 adds
    // its signature, node 0 submits
    const setupId = JSON.parse(fs.readFileSync(path.join(nodes[0].dataDir, "config.json"), "utf8")).network.split("@")[0];
    const change = async (args: string[], label: string) => {
      const file = path.join(hybridDir, `change-${label}.json`);
      const built = await run(LEDGER, ["hybrid", ...args, "--out", file], nodes[0].dataDir, 30000);
      const signed = await run(LEDGER, ["hybrid", "sign", file], nodes[1].dataDir, 30000);
      const sent = await run(LEDGER, ["hybrid", "submit", file], nodes[0].dataDir, 30000);
      return check(built.code === 0 && signed.code === 0 && sent.code === 0, `${label}: ${sent.out.trim().split("\n").pop()}`);
    };
    const section = async () => {
      const setup = await storageGet(nodes[0].storageUrl, setupId);
      return setup.hybrid;
    };

    await change(["min-version", "99.0.0"], "raise minVersion");
    await until("the running hybrid to go outdated", async () => {
      const h = await health();
      return h?.reason === "outdated" ? true : undefined;
    }, 45000);
    check((await health()).ready === false, "a raised minVersion reaches the running hybrid: not ready, outdated");
    await change(["min-version", "5.0.0"], "lower minVersion");
    await until("the running hybrid to resume", async () => {
      const h = await health();
      return h?.ready ? true : undefined;
    }, 45000);
    report.ok("lowering it lets the hybrid resume without a restart");

    const second = fs.mkdtempSync(path.join(os.tmpdir(), "activehybrid-test2-"));
    await run(HYBRID, ["init", "--upstream", `127.0.0.1:${nodes[0].port}`, "--port", String(HYBRID_PORT + 1)], second);
    const secondKey = JSON.parse(fs.readFileSync(path.join(second, ".identity"), "utf8")).pub.pkcs8pem;
    const secondHash = ActiveCrypto.keyHash(secondKey);
    const secondRegister = () => run(HYBRID, ["register", "--endpoint", `http://127.0.0.1:${HYBRID_PORT + 1}`], second);

    await change(["admission", "allowlist"], "admission allowlist");
    check((await section()).admission?.allowlist?.length === 0, "the allowlist is empty");
    check((await secondRegister()).code !== 0, "an unlisted key can no longer register");
    await change(["allow", secondHash], "allow");
    check((await section()).admission?.allowlist?.includes(secondHash), "the key is on the ledger's allowlist");
    const allowed = await secondRegister();
    check(allowed.code === 0, `an allowed key registers: ${allowed.out.trim().split("\n").pop()}`);
    await change(["deny", secondHash], "deny");
    check(!(await section()).admission?.allowlist?.includes(secondHash), "deny takes it off again");
    await change(["admission", "open"], "admission open");
    check((await section()).admission === "open", "admission is open again");

    report.phase("Status, stop and resume");
    const status = await run(HYBRID, ["status"], hybridDir);
    check(status.code === 0, `status: ${status.out.trim()}`);
    const stop = await run(HYBRID, ["stop"], hybridDir, 40000);
    check(stop.code === 0, `stop: ${stop.out.trim()}`);
    await runContract(nodes[2].baseUrl, identity, "hybridtest", contractId, { message: "while-stopped" });
    const restart = await run(HYBRID, ["start", "--quiet"], hybridDir, 120000);
    check(restart.code === 0, "restarted");
    await until("hybrid caught up after restart", async () => {
      const chain = await storageGet(nodes[0].storageUrl, identity.streamId);
      const mine = await requestJson(`http://127.0.0.1:${HYBRID_PORT}/stream/${identity.streamId}`, "GET").catch(() => undefined);
      return mine?.stream?._rev === chain._rev ? true : undefined;
    }, 60000);
    report.ok("caught up on what it missed while stopped");
  } catch (e) {
    passed = false;
    report.fail(`aborted: ${(e as Error).message}`);
    try {
      console.log("health:", JSON.stringify(await health()));
      try {
        const cfgNow = JSON.parse(fs.readFileSync(path.join(harness.nodes[0].dataDir, "config.json"), "utf8"));
        console.log("node 0 config.network:", cfgNow.network, JSON.stringify((await storageGet(harness.nodes[0].storageUrl, String(cfgNow.network).split("@")[0])).hybrid));
      } catch (x) {
        console.log("setup read failed:", (x as Error).message);
      }
      const { HttpUpstream, loadIdentity } = await import("../../packages/hybrid/src/http-upstream");
      const up = new HttpUpstream({ host: "127.0.0.1", port: 5610, identity: loadIdentity(path.join(hybridDir, ".identity")) });
      console.log("head:", JSON.stringify(await up.head()));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 4000);
      await up.feed("", async (c, item) => void console.log("feed item", c, item.outcome), ac.signal, (h, t, m) => console.log("heartbeat", h, t, "minVersion", m)).catch((x) => console.log("feed error:", x.message));
    } catch (x) {
      console.log("diagnostics failed:", (x as Error).message);
    }
    try {
      console.log("hybrid log:\n" + fs.readFileSync(path.join(hybridDir, "activehybrid.log"), "utf8").split("\n").slice(-30).join("\n"));
    } catch {
      // no log
    }
    try {
      console.log(fs.readFileSync(path.join(hybridDir, "activehybrid.log"), "utf8").split("\n").slice(-25).join("\n"));
    } catch {
      // no log
    }
  } finally {
    await run(HYBRID, ["stop"], hybridDir, 20000).catch(() => undefined);
    await harness.stop();
    console.log(`\nhybrid dir: ${hybridDir}  nodes: ${harness.nodes.map((n) => n.dataDir).join(" ")}`);
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
