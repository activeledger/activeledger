/**
 * Live check of premium hybrids on a real 3-supernode network: with room for
 * one feed, a free hybrid holds it until a premium one asks, then it is moved
 * on with the other supernodes to try, and cannot take the slot back. Not a
 * Mocha suite - run via `npm run test:network:hybrid-tiers` (needs a build).
 */

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson } from "./http";
import { Report } from "./report";
import { ActiveCrypto } from "../../packages/crypto/src";

const LEDGER = path.resolve(__dirname, "../../packages/activeledger/lib/index.js");
const HYBRID = path.resolve(__dirname, "../../packages/hybrid/lib/index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(entry: string, args: string[], cwd: string, timeoutMs = 30000): Promise<{ code: number | null; out: string }> {
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
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** Open a feed as this hybrid and collect what the supernode sends */
const openFeed = (port: number, dir: string) => {
  const id = JSON.parse(fs.readFileSync(path.join(dir, ".identity"), "utf8"));
  const keyHash = ActiveCrypto.keyHash(id.pub.pkcs8pem);
  const signed = ActiveCrypto.signRequest(new ActiveCrypto.KeyPair(id.type || "rsa", id.prv.pkcs8pem), keyHash, Date.now());
  const feed = { status: 0, text: "", ended: false, req: undefined as unknown as http.ClientRequest, keyHash };
  feed.req = http.get(
    {
      host: "127.0.0.1",
      port,
      path: "/h/feed",
      agent: false,
      headers: { "x-hybrid-key": signed.key, "x-hybrid-timestamp": String(signed.timestamp), "x-hybrid-signature": signed.signature },
    },
    (res) => {
      feed.status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (c) => (feed.text += c));
      res.on("end", () => (feed.ended = true));
      res.on("close", () => (feed.ended = true));
    }
  );
  feed.req.on("error", () => (feed.ended = true));
  return feed;
};

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({
    nodeCount: 3,
    basePort: 5850,
    config: {
      build: 40300,
      hybrid: { admission: "open", required: [], window: { days: 30 }, minVersion: "5.0.0" },
      hybridMaxFeeds: 1,
      hybridPremiumSlots: 0,
    },
    readyTimeoutMs: 40000,
  });
  const dirs = [0, 1].map((i) => fs.mkdtempSync(path.join(os.tmpdir(), `activehybrid-tier-${i}-`)));
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };
  const feeds: { req: http.ClientRequest }[] = [];

  try {
    report.phase("Booting 3 supernodes, asserting the network");
    const nodes = await harness.start();
    const asserted = await run(LEDGER, ["--assert"], nodes[0].dataDir);
    const cfg = JSON.parse(fs.readFileSync(path.join(nodes[0].dataDir, "config.json"), "utf8"));
    if (!check(!!cfg.network, `network asserted (${cfg.network ?? asserted.out.slice(-200)})`)) throw new Error("assert failed");
    for (let i = 0; i < nodes.length; i++) await harness.killNode(i);
    await Promise.all(nodes.map((_, i) => harness.restartNode(i)));
    await until("all nodes settled", async () => {
      const states = await Promise.all(nodes.map((n) => requestJson(`${n.baseUrl}/a/status`, "GET").catch(() => undefined)));
      return states.every((s) => s?.status === 4) ? true : undefined;
    }, 60000);

    report.phase("Registering two hybrids");
    for (let i = 0; i < 2; i++) {
      const init = await run(HYBRID, ["init", "--upstream", `127.0.0.1:${nodes[0].port}`, "--port", String(5880 + i)], dirs[i]);
      const reg = await run(HYBRID, ["register", "--endpoint", `http://127.0.0.1:${5880 + i}`], dirs[i]);
      check(init.code === 0 && reg.code === 0, `hybrid ${i} registered (${reg.out.trim().split("\n").pop()})`);
    }
    await sleep(2000);

    const node = nodes[0];
    report.phase("One slot: a free hybrid has it, a premium one takes it");
    const free = openFeed(node.port, dirs[0]);
    feeds.push(free);
    await until("the free feed", async () => (free.status === 200 && free.text.includes("heartbeat")) || undefined, 15000);
    check(true, "the free hybrid holds the only slot");

    const tier = await requestJson(`${node.baseUrl}/a/hybrid/tier`, "POST", { keyHash: ActiveCrypto.keyHash(JSON.parse(fs.readFileSync(path.join(dirs[1], ".identity"), "utf8")).pub.pkcs8pem) });
    check(tier?.ok === true, "the second hybrid is made premium");

    const vip = openFeed(node.port, dirs[1]);
    feeds.push(vip);
    await until("the premium feed", async () => (vip.status === 200 && vip.text.includes("heartbeat")) || undefined, 15000);
    check(true, "the premium hybrid gets a feed");
    await until("the free feed to end", async () => free.ended || undefined, 15000);
    check(free.text.includes("event: error") && free.text.includes('"error":"moved"'), "the free hybrid is told it was moved");
    const sent = /"try":(\[.*?\])/.exec(free.text);
    const tryList = sent ? JSON.parse(sent[1]) : [];
    check(tryList.length === 2 && tryList.every((a: any) => a.host && a.port), `and is given the other supernodes to try (${sent?.[1] ?? "none"})`);

    const again = openFeed(node.port, dirs[0]);
    feeds.push(again);
    await until("the refusal", async () => again.status === 503 || undefined, 15000);
    await sleep(300);
    check(again.status === 503 && again.text.includes("feed limit reached") && again.text.includes('"try"'), "the free hybrid cannot take it back, and is told where else to go");

    const status = await requestJson(`${node.baseUrl}/a/hybrid/feeds`, "GET");
    check(status.count === 1 && status.feeds[0].tier === 0, `hybrid feeds shows the premium feed (${JSON.stringify(status.feeds)})`);
    const list = await requestJson(`${node.baseUrl}/a/hybrid/list`, "GET");
    check(Array.isArray(list) && list.some((h: any) => h.tier === 0) && list.some((h: any) => h.tier === -1), "hybrid list shows who is premium");
    const file = path.join(node.dataDir, "hybrid-tiers.json");
    check(fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).flat().length === 1, "the tier is saved in hybrid-tiers.json");

    const gone = await requestJson(`${node.baseUrl}/a/hybrid/untier`, "POST", { keyHash: vip.keyHash });
    check(gone?.ok === true, "untier puts it back to free");
  } catch (e) {
    check(false, `error: ${(e as Error).message}`);
  } finally {
    feeds.forEach((f) => f.req.destroy());
    await harness.stop();
    console.log(`\nhybrid dirs: ${dirs.join(" ")}  nodes: ${harness.nodes.map((n) => n.dataDir).join(" ")}`);
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
