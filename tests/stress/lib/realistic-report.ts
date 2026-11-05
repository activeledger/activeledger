/**
 * One page PDF summary of a stress:realistic results file. The page is plain
 * HTML with an inline SVG chart, printed by a headless Chromium/Chrome (found
 * from CHROME_BIN, PATH, or the Playwright/Puppeteer caches). The HTML is
 * written next to the PDF too, so a machine without a browser still gets
 * the report.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { readRecords } from "./results";

const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

export function findBrowser(): string | undefined {
  const candidates: string[] = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const r = spawnSync("which", [n], { encoding: "utf8" });
    if (r.status === 0) candidates.push(r.stdout.trim());
  }
  const roots = [path.join(os.homedir(), ".cache/ms-playwright"), path.join(os.homedir(), ".cache/puppeteer")];
  for (const root of roots) {
    const r = spawnSync("find", [root, "-type", "f", "(", "-name", "chrome", "-o", "-name", "headless_shell", ")"], { encoding: "utf8" });
    if (r.status === 0) candidates.push(...r.stdout.split("\n").filter(Boolean));
  }
  return candidates.find((c) => fs.existsSync(c));
}

interface Run { offeredTps: number; committedTps: number; committedPctOfOffered: number; failedPct: number; p50Ms: number; p90Ms: number; p99Ms: number; cpuCores: Record<string, number>; sustained: boolean; loadBefore: { load1: number }; loadAfter: { load1: number }; generatorLagP99Ms: number; poolExhausted?: number }

function chart(runs: Run[]): string {
  const W = 330, H = 190, L = 40, B = 28, T = 10, R = 40;
  const maxX = Math.max(...runs.map((r) => r.offeredTps)) * 1.05;
  const maxP = Math.max(...runs.map((r) => r.p99Ms), 100) * 1.1;
  const x = (v: number) => L + (v / maxX) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxX) * (H - T - B);
  const yp = (v: number) => T + (1 - v / maxP) * (H - T - B);
  const pts = (f: (r: Run) => string) => runs.map(f).join(" ");
  const ticks = runs.map((r) => `<text x="${x(r.offeredTps)}" y="${H - 14}" font-size="8" text-anchor="middle" fill="#555">${r.offeredTps}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
<line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="#999"/><line x1="${L}" y1="${T}" x2="${L}" y2="${y(0)}" stroke="#999"/>
<line x1="${x(0)}" y1="${y(0)}" x2="${x(maxX)}" y2="${y(maxX)}" stroke="#bbb" stroke-dasharray="3 3"/>
<polyline fill="none" stroke="#1f6feb" stroke-width="2" points="${pts((r) => `${x(r.offeredTps)},${y(r.committedTps)}`)}"/>
${runs.map((r) => `<circle cx="${x(r.offeredTps)}" cy="${y(r.committedTps)}" r="3" fill="${r.sustained ? "#1f6feb" : "#d1242f"}"/>`).join("")}
<polyline fill="none" stroke="#e08a00" stroke-width="1.5" points="${pts((r) => `${x(r.offeredTps)},${yp(r.p99Ms)}`)}"/>
${runs.map((r) => `<circle cx="${x(r.offeredTps)}" cy="${yp(r.p99Ms)}" r="2.5" fill="#e08a00"/>`).join("")}
${ticks}
<text x="${(L + W - R) / 2}" y="${H - 3}" font-size="8" text-anchor="middle" fill="#555">offered tx/s</text>
<text x="4" y="${T + 6}" font-size="8" fill="#1f6feb">committed tx/s (dashed: ideal)</text>
<text x="${W - R + 4}" y="${yp(runs[runs.length - 1].p99Ms) + 3}" font-size="8" fill="#e08a00">p99 ms</text>
<text x="${W - R + 4}" y="${yp(0) - 2}" font-size="7" fill="#e08a00">0</text><text x="${W - R + 4}" y="${T + 18}" font-size="7" fill="#e08a00">${Math.round(maxP)}</text>
</svg>`;
}

export function buildHtml(file: string): string {
  const all = readRecords<any>(file);
  const metaIdx = all.map((r) => r.kind).lastIndexOf("meta");
  const meta = all[metaIdx];
  if (!meta) throw new Error(`${file}: no meta record (not a stress:realistic file)`);
  const runs: Run[] = all.slice(metaIdx).filter((r) => r.kind === "run");
  if (!runs.length) throw new Error(`${file}: no completed steps`);
  const sustainedRuns = runs.filter((r) => r.sustained);
  const best = sustainedRuns.length ? sustainedRuns[sustainedRuns.length - 1] : undefined;
  const peak = runs.reduce((a, b) => (b.committedTps > a.committedTps ? b : a));
  const loads = runs.flatMap((r) => [r.loadBefore.load1, r.loadAfter.load1]);
  const maxLoad = Math.max(...loads);
  const cores = meta.cpus;
  const cpuRows = (best || peak).cpuCores;
  const totalCores = Object.values(cpuRows).reduce((a, b) => a + b, 0);
  const lagWarn = runs.some((r) => r.generatorLagP99Ms > 50);
  const date = new Date(meta.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const headline = best
    ? `Sustained <b>${best.committedTps} tx/s</b> on ${meta.nodes} nodes with p99 ${best.p99Ms} ms`
    : `No step was sustained; the best committed rate was <b>${peak.committedTps} tx/s</b>`;
  const rows = runs
    .map((r) => `<tr class="${r.sustained ? "ok" : "no"}"><td>${r.offeredTps}</td><td>${r.committedTps}</td><td>${r.committedPctOfOffered}%</td><td>${r.failedPct}%</td><td>${r.p50Ms}</td><td>${r.p90Ms}</td><td>${r.p99Ms}</td><td>${(Object.values(r.cpuCores) as number[]).reduce((a, b) => a + b, 0).toFixed(1)}</td><td>${r.sustained ? "yes" : "no"}</td></tr>`)
    .join("");
  const cpuList = Object.entries(cpuRows).map(([k, v]) => `${esc(k)} ${v}`).join(", ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Activeledger throughput</title><style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font:9.5pt/1.35 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1f24;margin:0}
h1{font-size:17pt;margin:0 0 2px}h2{font-size:10.5pt;margin:10px 0 3px;border-bottom:1px solid #d0d7de;padding-bottom:2px}
.sub{color:#57606a;font-size:8.5pt}.head{font-size:12.5pt;margin:8px 0;padding:8px 10px;background:#eef4ff;border-left:4px solid #1f6feb}
table{border-collapse:collapse;width:100%;font-size:8.5pt}th,td{padding:2px 6px;text-align:right;border-bottom:1px solid #e5e8eb}th{background:#f6f8fa}td:first-child,th:first-child{text-align:left}
tr.no td{color:#a40e26}.cols{display:flex;gap:14px}.cols>div{flex:1}ul{margin:3px 0 0 16px;padding:0}li{margin-bottom:2px}
.warn{background:#fff4e5;border-left:4px solid #e08a00;padding:5px 9px;margin-top:8px;font-size:8.5pt}.small{font-size:8pt;color:#57606a}
</style></head><body>
<h1>Activeledger: transaction throughput</h1>
<div class="sub">${esc(date)} · commit ${esc(meta.commit || "n/a")} · ${meta.nodes}-node network on one machine · ${meta.users} distinct users · open-loop load</div>
<div class="head">${headline}</div>
<div class="cols"><div>
<h2>What was measured</h2>
<ul>
<li>A ${meta.nodes}-node network, started from empty and driven through its public HTTP interface like any client.</li>
<li>${meta.users} distinct users, each with their own key and stream, all onboarded first.</li>
<li>Mix: ${100 - meta.joinPct}% contract transactions on the user's own stream (${meta.contract === "returner" ? "the contract writes a state update" : "a light contract that validates and returns a value, writing no state"}), ${meta.joinPct}% new users joining; signed in advance (secp256k1, as clients sign on their own hardware) and submitted to a node chosen in turn; the nodes verify every signature.</li>
<li>Arrivals are random (Poisson) at a fixed offered rate for ${meta.durationSec - meta.warmupSec} s after a ${meta.warmupSec} s warm-up, whether or not earlier transactions have been answered. A network that cannot keep up shows as committed &lt; offered and rising latency.</li>
<li>A step is <b>sustained</b> if at least ${meta.sustainPct ?? 97}% of the offered rate committed, no more than ${meta.maxFailPct ?? 0.5}% failed, and p99 latency stayed under ${(meta.maxP99Ms ?? 3000) / 1000} s.</li>
<li>Latency is the full time to a committed response, p50/p90/p99 in ms.</li>
</ul></div><div>${chart(runs)}</div></div>
<h2>Results by offered rate</h2>
<table><tr><th>offered tx/s</th><th>committed tx/s</th><th>of offered</th><th>failed</th><th>p50 ms</th><th>p90 ms</th><th>p99 ms</th><th>CPU cores</th><th>sustained</th></tr>${rows}</table>
<div class="small" style="margin-top:3px">CPU cores used by the whole network (all nodes, storage and contract workers) in the best sustained step (or the peak): ${totalCores.toFixed(1)} of ${cores} logical cores (${cpuList}).</div>
<h2>Read this with these caveats</h2>
<ul>
<li><b>This is a busy shared machine, not dedicated hardware.</b> It ran ${cores} logical cores (${esc(meta.cpuModel || "")}), ${meta.totalMemGb} GB RAM, under WSL2, with other work running: load average reached ${maxLoad.toFixed(1)} during the test. All ${meta.nodes} nodes, the storage engines and the load generator shared those cores.</li>
<li><b>Real deployments should do better.</b> Nodes on separate machines have their own CPU, memory and disk, the load generator is not competing for them, and network latency is the only added cost. Treat these figures as a floor for a ${meta.nodes}-node network, not a ceiling.</li>
<li>The contract is deliberately light${meta.contract === "returner" ? "" : " and writes no state"}; contracts that write state, compute heavily or touch many streams will commit fewer transactions per second. There is no rate limit on users: the many distinct users keep lock contention low, as a real population does.</li>
<li>A single short run per step: a few minutes in all. Expect a few percent of run-to-run variation; the tool's other modes (<code>stress:throughput</code>, <code>stress:compare</code>) quantify that spread.</li>
<li>Nodes are on one host, so there is no wide-area latency in these figures; users' own network latency adds to what they see.</li>
${lagWarn ? '<li class="warn">At some steps the load generator\'s own timer ran late, so the machine was too busy to offer that rate cleanly; those steps understate the network.</li>' : ""}
</ul>
<div class="small" style="margin-top:6px">Reproduce: <code>npm run build && npm run stress:realistic -- --pdf report.pdf</code> (tests/stress/realistic.ts). Raw results: ${esc(path.basename(file))}.</div>
</body></html>`;
}

/** Builds the HTML and prints it to PDF. Throws if no browser can be found; the HTML is kept either way. */
export async function writeRealisticPdf(resultsFile: string, pdfPath: string): Promise<void> {
  const html = buildHtml(resultsFile);
  const htmlPath = pdfPath.replace(/\.pdf$/i, "") + ".html";
  fs.mkdirSync(path.dirname(path.resolve(pdfPath)), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  const browser = findBrowser();
  if (!browser) throw new Error(`no Chrome/Chromium found to print the PDF (set CHROME_BIN); the HTML report is at ${htmlPath}`);
  const r = spawnSync(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${path.resolve(pdfPath)}`, `file://${path.resolve(htmlPath)}`], { encoding: "utf8", timeout: 60000 });
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not written: ${(r.stderr || "").slice(-300)}`);
}
