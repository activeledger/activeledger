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
  const W = 460, H = 150, L = 40, B = 28, T = 10, R = 10;
  const all = series.flatMap((s) => s.runs);
  const maxX = Math.max(...all.map((r) => r.offeredTps)) * 1.05;
  const x = (v: number) => L + (v / maxX) * (W - L - R);
  // The vertical axis is zoomed to what was confirmed, so the lines are not squashed against
  // the bottom of the page; where it starts is written on the chart.
  const confirmedAll = all.map((r) => confirmed(r));
  const lo = Math.min(...confirmedAll), hi = Math.max(...confirmedAll);
  // Evenly spaced gridlines, a round step that gives about five of them.
  const step = [50, 100, 200, 250, 500, 1000].find((t) => (hi * 1.05 - lo * 0.85) / t <= 5) ?? 1000;
  const yMin = Math.max(0, Math.floor((lo * 0.85) / step) * step);
  const yMax = Math.max(yMin + step, Math.ceil((hi * 1.05) / step) * step);
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const grid: number[] = [];
  for (let g = yMin + step; g <= yMax; g += step) grid.push(g);
  const rates = [...new Set(all.map((r) => r.offeredTps))].sort((a, b) => a - b);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
${grid.map((g) => `<line x1="${L}" y1="${y(g)}" x2="${W - R}" y2="${y(g)}" stroke="#eceff2"/><text x="${L - 4}" y="${y(g) + 3}" font-size="8" text-anchor="end" fill="#666">${fmt(g)}</text>`).join("")}
<line x1="${L}" y1="${y(yMin)}" x2="${W - R}" y2="${y(yMin)}" stroke="#999"/><text x="${L - 4}" y="${y(yMin) + 3}" font-size="8" text-anchor="end" fill="#666">${fmt(yMin)}</text>
${series.map((s) => `<polyline fill="none" stroke="${s.colour}" stroke-width="2.2" points="${s.runs.map((r) => `${x(r.offeredTps)},${y(confirmed(r))}`).join(" ")}"/>${s.runs.map((r) => `<circle cx="${x(r.offeredTps)}" cy="${y(confirmed(r))}" r="3" fill="${s.colour}"/>`).join("")}`).join("")}
${rates.map((r) => `<text x="${x(r)}" y="${H - 14}" font-size="7.5" text-anchor="middle" fill="#666">${fmt(r)}</text>`).join("")}
<text x="${(L + W - R) / 2}" y="${H - 3}" font-size="8" text-anchor="middle" fill="#666">transactions per second sent</text>
${yMin > 0 ? `<text x="${W - R}" y="${H - 3}" font-size="7" text-anchor="end" fill="#888">vertical axis starts at ${fmt(yMin)}</text>` : ""}
${series.map((s, i) => `<text x="${L + 10}" y="${T + 11 + i * 12}" font-size="9" font-weight="600" fill="${s.colour}">${s.label} confirmed per second</text>`).join("")}
</svg>`;
}

/** The three kinds of transaction the peak test measures, in the order the page shows them. */
const KINDS = ["Reads", "Locked reads", "Writes"];
const COLOURS: Record<string, string> = { Reads: "#1f6feb", "Locked reads": "#8250df", Writes: "#1a7f37" };

/**
 * What a results file measured, from the contract it ran. `read-only` reads on
 * the ledger without locking or writing (the "Reads"); `no-write` goes through
 * the lock on a stream but writes nothing; `returner` writes. Where no
 * lock-free read was measured, `no-write` is the page's "Reads", as it always was.
 */
export function kindOf(contract: string, hasLockFreeReads: boolean): string {
  if (contract === "returner") return "Writes";
  if (contract === "read-only") return "Reads";
  return hasLockFreeReads ? "Locked reads" : "Reads";
}

function loadSeries(file: string): { runs: Run[]; peak: Run; contract: string; meta: any; maxLoad: number } {
  const all = readRecords<any>(file);
  const metaIdx = all.map((r) => r.kind).lastIndexOf("meta");
  const meta = all[metaIdx];
  if (!meta) throw new Error(`${file}: no meta record (not a stress:realistic file)`);
  const runs: Run[] = all.slice(metaIdx).filter((r) => r.kind === "run");
  if (!runs.length) throw new Error(`${file}: no completed steps`);
  // Only the rates the network held; a step it could not hold is not shown
  const held = runs.filter((r) => r.sustained);
  if (!held.length) throw new Error(`${file}: no step was sustained, so there is nothing to show`);
  return {
    runs: held,
    peak: held[held.length - 1],
    contract: meta.contract,
    meta,
    maxLoad: Math.max(...runs.flatMap((r) => [r.loadBefore.load1, r.loadAfter.load1])),
  };
}

/** One results file per kind of transaction (reads, locked reads, writes); a single file gives a single headline. */
export function buildHtml(files: string[]): string {
  const loaded = files.map(loadSeries);
  const hasLockFree = loaded.some((l) => l.contract === "read-only");
  const series: Series[] = loaded
    .map((l) => {
      const label = kindOf(l.contract, hasLockFree);
      return { label, runs: l.runs, peak: l.peak, colour: COLOURS[label] };
    })
    .sort((a, b) => KINDS.indexOf(a.label) - KINDS.indexOf(b.label));
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
.cols{display:flex;gap:18px;align-items:flex-start;margin-top:12px}.cols>div{flex:1}.cols>div:first-child{flex:1.7}
table{border-collapse:collapse;width:100%;font-size:9.5pt}th,td{padding:3px 7px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5e8eb}th{background:#f6f8fa;font-weight:600}td:first-child,th:first-child{text-align:left}
h2{font-size:11pt;margin:8px 0 3px}.chart{margin:10px 0 0}ul{margin:4px 0 0 16px;padding:0;font-size:9pt}li{margin-bottom:3px}.small{color:#57606a;font-size:8.5pt;margin-top:14px}
</style></head><body>
<h1>Activeledger throughput</h1>
<div class="sub">${meta.nodes}-node network on one PC &middot; ${esc(date)}</div>
<div class="heroes">${heroes}</div>
<p class="lead">Every transaction confirmed (final) by the network. ${hasLockFree ? "Reads run a contract that looks up ledger data, with no lock and no write; locked reads do the same on a stream the network locks while it agrees; writes update ledger state." : "Reads check or look up data; writes update ledger state."}</p>
<table><tr><th>Sent per sec</th>${head}</tr>${rows}</table>
<div class="chart">${chart(series)}</div>
<h2>Please note</h2>
<ul>
<li>Measured on a shared, busy PC (${meta.cpus} threads, load average up to ${maxLoad.toFixed(0)}); dedicated servers built for the job will deliver more.</li>
<li>All ${meta.nodes} nodes of the network ran on this one machine, sharing its CPU and disk.</li>
<li>${hasLockFree ? "Reads, locked reads and writes were all tested" : "Reads and writes were both tested"}; writes are the most demanding because every write is stored to disk.</li>
<li>This peak load test steps the rate up for a few minutes to find the highest rate the network holds.</li>
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
