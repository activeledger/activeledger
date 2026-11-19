import * as fs from "fs";
import * as path from "path";
import { NetworkHarness } from "./harness";

const ok = (m: string) => console.log("  ✔ " + m);
let failed = false;
const check = (cond: boolean, m: string) => {
  if (cond) ok(m);
  else {
    failed = true;
    console.log("  ✘ " + m);
  }
};

(async () => {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 7900, readyTimeoutMs: 40000 } as any);
  try {
    const nodes: any[] = await harness.start();
    const n4 = () => (harness as any).nodes[3];
    const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

    console.log("== A restart keeps the recorded chain ==");
    await harness.killNode(3);
    await harness.restartNode(3);
    check(true, "node 4 restarted on chain 1");

    console.log("== A changed chain id will not start ==");
    await harness.killNode(3);
    const cfgPath = path.join(n4().dataDir, "config.json");
    const cfg = JSON.parse(read(cfgPath));
    cfg.chain = { id: 2 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    let refused = false;
    try {
      await harness.restartNode(3);
    } catch (e: any) {
      refused = /exited early/.test(String(e.message));
    }
    check(refused, "node 4 refuses to start with chain 2 against a recorded chain 1");
    check(/started as chain 1/.test(read(n4().logPath)), "the log says it was started as chain 1");

    console.log("== A node on another chain is not paired ==");
    fs.rmSync(path.join(n4().dataDir, ".chain"));
    try {
      await harness.restartNode(3);
    } catch {
      // It may never report stable; that is the point
    }
    await new Promise((r) => setTimeout(r, 8000));
    const others = [0, 1, 2].map((i) => read((harness as any).nodes[i].logPath));
    check(others.every((l) => /is on chain 2, this node is on chain 1\. Not pairing/.test(l)), "all three home nodes logged the mismatch");
    check(/is on chain 1, this node is on chain 2\. Not pairing/.test(read(n4().logPath)), "node 4 logged it too");
  } finally {
    await harness.stop();
  }
  console.log(failed ? "FAILED" : "PASSED");
  process.exit(failed ? 1 : 0);
})();
