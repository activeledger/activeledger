import * as fs from "fs";
import { NetworkHarness } from "./harness";
(async () => {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 7900, readyTimeoutMs: 60000 } as any);
  try {
    await harness.start();
    await new Promise((r) => setTimeout(r, 30000));
    const nodes = (harness as any).nodes as any[];
    console.log(fs.readFileSync(nodes[0].logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, 42).map((x) => x.slice(0, 150)).join("\n"));
    for (const n of nodes) {
      const l = fs.readFileSync(n.logPath, "utf8").split("\n");
      console.log(n.logPath.split("/").slice(-2).join("/"), "lines", l.length, "STATUSKNOCK", l.filter((x) => x.includes("STATUSKNOCK")).length, "fully", l.filter((x) => /fully discovered/.test(x)).length, "Left/right", l.filter((x) => /Left\/right/.test(x)).length);
    }
  } finally {
    await harness.stop();
  }
  process.exit(0);
})();
