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

interface Run { offeredTps: number; committedTps: number; p50Ms: number; p99Ms: number; sustained: boolean; loadBefore: { load1: number }; loadAfter: { load1: number } }

/** Confirmed tx/s as shown: what the network committed, never above what was offered (the gap is timing noise at the window's edges). */
const confirmed = (r: Run) => Math.round(Math.min(r.committedTps, r.offeredTps));
const fmt = (n: number) => n.toLocaleString("en-GB");
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

interface Series { label: string; runs: Run[]; peak: Run; colour: string }

function chart(series: Series[]): string {
  const W = 460, H = 190, L = 40, B = 28, T = 10, R = 10;
  const all = series.flatMap((s) => s.runs);
  const maxX = Math.max(...all.map((r) => r.offeredTps)) * 1.05;
  const x = (v: number) => L + (v / maxX) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxX) * (H - T - B);
  const grid = [0.25, 0.5, 0.75, 1].map((f) => Math.round((maxX * f) / 100) * 100);
  const rates = [...new Set(all.map((r) => r.offeredTps))].sort((a, b) => a - b);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
${grid.map((g) => `<line x1="${L}" y1="${y(g)}" x2="${W - R}" y2="${y(g)}" stroke="#eceff2"/><text x="${L - 4}" y="${y(g) + 3}" font-size="8" text-anchor="end" fill="#666">${fmt(g)}</text>`).join("")}
<line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="#999"/>
${series.map((s) => `<polyline fill="none" stroke="${s.colour}" stroke-width="2.2" points="${s.runs.map((r) => `${x(r.offeredTps)},${y(confirmed(r))}`).join(" ")}"/>${s.runs.map((r) => `<circle cx="${x(r.offeredTps)}" cy="${y(confirmed(r))}" r="3" fill="${s.colour}"/>`).join("")}`).join("")}
${rates.map((r) => `<text x="${x(r)}" y="${H - 14}" font-size="7.5" text-anchor="middle" fill="#666">${fmt(r)}</text>`).join("")}
<text x="${(L + W - R) / 2}" y="${H - 3}" font-size="8" text-anchor="middle" fill="#666">transactions per second sent</text>
${series.map((s, i) => `<text x="${L + 10}" y="${T + 11 + i * 12}" font-size="9" font-weight="600" fill="${s.colour}">${s.label} confirmed per second</text>`).join("")}
</svg>`;
}

function loadSeries(file: string): { series: Series; meta: any; maxLoad: number } {
  const all = readRecords<any>(file);
  const metaIdx = all.map((r) => r.kind).lastIndexOf("meta");
  const meta = all[metaIdx];
  if (!meta) throw new Error(`${file}: no meta record (not a stress:realistic file)`);
  const runs: Run[] = all.slice(metaIdx).filter((r) => r.kind === "run");
  if (!runs.length) throw new Error(`${file}: no completed steps`);
  // Only the rates the network held; a step it could not hold is not shown
  const held = runs.filter((r) => r.sustained);
  if (!held.length) throw new Error(`${file}: no step was sustained, so there is nothing to show`);
  const writes = meta.contract === "returner";
  return {
    series: { label: writes ? "Writes" : "Reads", runs: held, peak: held[held.length - 1], colour: writes ? "#1a7f37" : "#1f6feb" },
    meta,
    maxLoad: Math.max(...runs.flatMap((r) => [r.loadBefore.load1, r.loadAfter.load1])),
  };
}

/** One results file per kind of transaction (reads, writes); a single file gives a single headline. */
export function buildHtml(files: string[]): string {
  const loaded = files.map(loadSeries);
  const series = loaded.map((l) => l.series).sort((a, b) => (a.label === "Reads" ? -1 : b.label === "Reads" ? 1 : 0));
  const meta = loaded[0].meta;
  const maxLoad = Math.max(...loaded.map((l) => l.maxLoad));
  const date = new Date(meta.ts).toISOString().slice(0, 10);
  const rates = [...new Set(series.flatMap((s) => s.runs.map((r) => r.offeredTps)))].sort((a, b) => a - b);
  const cell = (s: Series, rate: number, f: (r: Run) => string) => {
    const r = s.runs.find((x) => x.offeredTps === rate);
    return `<td>${r ? f(r) : "N/A"}</td>`;
  };
  const head = series.map((s) => `<th>${s.label}</th><th>99% within</th>`).join("");
  const rows = rates
    .map((rate) => `<tr><td>${fmt(rate)}</td>${series.map((s) => cell(s, rate, (r) => fmt(confirmed(r))) + cell(s, rate, (r) => ms(r.p99Ms))).join("")}</tr>`)
    .join("");
  const heroes = series
    .map((s) => `<div class="hero" style="border-color:${s.colour}"><div class="kind" style="color:${s.colour}">${s.label}</div><div class="big">${fmt(confirmed(s.peak))} <small>per second</small></div><p>99% confirmed within ${ms(s.peak.p99Ms)}</p></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Activeledger throughput</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:11pt/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1f24;margin:0}
h1{font-size:18pt;margin:0}.sub{color:#57606a;font-size:9.5pt;margin-top:2px}
.heroes{display:flex;gap:14px;margin:16px 0 8px}.hero{flex:1;padding:12px 16px;background:#f6f8fa;border-left:5px solid #1f6feb}
.kind{font-size:10.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.big{font-size:32pt;font-weight:700;line-height:1.05}.big small{font-size:12pt;font-weight:400;color:#444}
.hero p{margin:3px 0 0;font-size:10.5pt}
.lead{margin:0 0 12px;font-size:10.5pt;color:#444}
.cols{display:flex;gap:18px;align-items:flex-start}.cols>div{flex:1}.cols>div:first-child{flex:1.9}
table{border-collapse:collapse;width:100%;font-size:9.5pt}th,td{padding:4px 7px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5e8eb}th{background:#f6f8fa;font-weight:600}td:first-child,th:first-child{text-align:left}
h2{font-size:11pt;margin:10px 0 4px}.chart{margin:12px 0 0}ul{margin:4px 0 0 18px;padding:0}li{margin-bottom:4px}.small{color:#57606a;font-size:8.5pt;margin-top:14px}
</style></head><body>
<h1>Activeledger throughput</h1>
<div class="sub">${meta.nodes}-node network on one PC &middot; ${esc(date)}</div>
<div class="heroes">${heroes}</div>
<p class="lead">Every transaction confirmed (final) by the network. Reads check or look up data; writes update ledger state.</p>
<table><tr><th>Sent per sec</th>${head}</tr>${rows}</table>
<div class="chart">${chart(series)}</div>
<h2>Please note</h2>
<ul>
<li>This is a shared, busy PC (${meta.cpus} threads, load up to ${maxLoad.toFixed(0)}), not dedicated hardware. Servers built for the job will do better.</li>
<li>All ${meta.nodes} nodes ran on this one machine, sharing its CPU and disk.</li>
<li>Both ends of the workload were tested: reads, and writes, which are the most demanding because every write is stored to disk.</li>
<li>Short test, a few minutes. Treat figures as a guide.</li>
<li>N/A means no result is shown at that rate.</li>
</ul>
<div class="small">Activeledger ${esc(meta.commit || "")} &middot; stress:realistic</div>
</body></html>`;
}

/** Builds the HTML and prints it to PDF. Throws if no browser can be found; the HTML is kept either way. */
export async function writeRealisticPdf(resultsFiles: string, pdfPath: string): Promise<void> {
  const html = buildHtml(resultsFiles.split(",").map((f) => f.trim()).filter(Boolean));
  const htmlPath = pdfPath.replace(/\.pdf$/i, "") + ".html";
  fs.mkdirSync(path.dirname(path.resolve(pdfPath)), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  const browser = findBrowser();
  if (!browser) throw new Error(`no Chrome/Chromium found to print the PDF (set CHROME_BIN); the HTML report is at ${htmlPath}`);
  const r = spawnSync(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${path.resolve(pdfPath)}`, `file://${path.resolve(htmlPath)}`], { encoding: "utf8", timeout: 60000 });
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not written: ${(r.stderr || "").slice(-300)}`);
}
