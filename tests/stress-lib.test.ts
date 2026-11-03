import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fisherExact, iqr, mean, median, minDetectableRateIncrease, percentile, quantile, slope, slopeFit, spread, summarise, tCritical95, wilson } from "./stress/lib/stats";
import { classifyRole, cpuSecondsByRole, memoryByRole, parseStat, ProcRow, statusKb } from "./stress/lib/proc";
import { waitForQuiet } from "./stress/lib/loadgate";
import { appendRecord, parseJsonl, readRecords, BaseRecord } from "./stress/lib/results";
import { compareRecords, compareSamples, extractMetrics, formatReport } from "./stress/lib/compare";
import { describeGrowth, growthLevel, rateResolution, valueResolution } from "./stress/lib/resolution";
import { human, parseNodeList, planColdStart, planMemory, planThroughput, THROUGHPUT_PROFILES, COLD_PROFILES, MEMORY_PROFILES } from "./stress/lib/plans";
import { applyProfile } from "./stress/lib/cli";
import { parseFlags, UsageError, FlagSpec } from "./stress/lib/cli";
import { deepMerge } from "./network/harness";

// Expected values below were computed outside this code: Fisher with exact
// rational arithmetic (Python fractions and math.comb), Wilson by solving the
// score equation as a quadratic. Several are published values too: the tea
// tasting table (Fisher 1935) gives p = 0.4857, Wikipedia's Fisher example
// gives p = 0.002759, and 81 of 263 gives the Wilson interval 0.2553-0.3662.
describe("Stress tools: library", () => {
  describe("statistics", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    it("median, quartiles and percentiles interpolate (type 7)", () => {
      expect(median(ten)).to.equal(5.5);
      expect(quantile(ten, 0.25)).to.equal(3.25);
      expect(quantile(ten, 0.75)).to.equal(7.75);
      expect(iqr(ten)).to.equal(4.5);
      expect(percentile(ten, 99)).to.be.closeTo(9.91, 1e-9);
      expect(percentile(ten, 0)).to.equal(1);
      expect(percentile(ten, 100)).to.equal(10);
    });

    it("does not depend on input order and does not modify the input", () => {
      const shuffled = [7, 1, 10, 3, 5, 9, 2, 8, 4, 6];
      expect(median(shuffled)).to.equal(5.5);
      expect(shuffled[0]).to.equal(7);
    });

    it("handles empty and single inputs", () => {
      expect(median([])).to.be.NaN;
      expect(mean([])).to.be.NaN;
      expect(median([4])).to.equal(4);
      expect(iqr([4])).to.equal(0);
    });

    it("summarise ignores non-finite values", () => {
      const s = summarise([1, 2, 3, NaN, Infinity]);
      expect(s.n).to.equal(3);
      expect(s.median).to.equal(2);
      expect(s.min).to.equal(1);
      expect(s.max).to.equal(3);
    });

    it("Wilson interval matches known answers", () => {
      const cases: [number, number, number, number][] = [
        [81, 263, 0.255289, 0.36621],
        [0, 10, 0, 0.277533],
        [10, 10, 0.722467, 1],
        [6, 50, 0.056176, 0.238048],
        [3, 100, 0.010255, 0.084519],
        [1, 1, 0.206549, 1],
      ];
      for (const [k, n, low, high] of cases) {
        const w = wilson(k, n);
        expect(w.low, `${k}/${n} low`).to.be.closeTo(low, 1e-5);
        expect(w.high, `${k}/${n} high`).to.be.closeTo(high, 1e-5);
      }
    });

    it("Wilson interval with no trials is the whole range", () => {
      expect(wilson(0, 0)).to.deep.equal({ low: 0, high: 1 });
    });

    it("Fisher exact test matches known answers", () => {
      const cases: [number, number, number, number, number][] = [
        [3, 1, 1, 3, 0.4857142857],
        [1, 9, 11, 3, 0.0027594562],
        [0, 12, 5, 7, 0.0372670807],
        [6, 94, 12, 88, 0.2158744878],
        [10, 0, 0, 10, 0.0000108251],
      ];
      for (const [a, b, c, d, p] of cases) {
        expect(fisherExact(a, b, c, d), `${a},${b},${c},${d}`).to.be.closeTo(p, 1e-9);
      }
    });

    it("Fisher exact test is symmetric in rows and columns and is 1 for an empty table", () => {
      expect(fisherExact(1, 9, 11, 3)).to.be.closeTo(fisherExact(11, 3, 1, 9), 1e-12);
      expect(fisherExact(1, 9, 11, 3)).to.be.closeTo(fisherExact(1, 11, 9, 3), 1e-12);
      expect(fisherExact(0, 0, 0, 0)).to.equal(1);
      expect(fisherExact(5, 5, 5, 5)).to.be.closeTo(1, 1e-9);
    });

    it("slope is the least squares slope", () => {
      expect(slope([0, 1, 2, 3], [1, 3, 5, 7])).to.be.closeTo(2, 1e-12);
      expect(slope([1, 2, 3], [5, 5, 5])).to.equal(0);
      expect(slope([1], [1])).to.be.NaN;
      expect(slope([2, 2, 2], [1, 2, 3])).to.be.NaN;
    });
  });

  describe("resolving power", () => {
    it("spread is half the range below five values and the IQR from five", () => {
      expect(spread([1, 2, 3, 4])).to.equal(1.5);
      expect(spread([1, 2, 3, 4, 5])).to.equal(2);
      expect(spread([7])).to.equal(0);
    });

    it("slope fit gives the standard error interval (t table, 3 df)", () => {
      // x 0..4, y 1 2 2 4 5: slope 1, standard error 0.1633, t(3) = 3.182
      const fit = slopeFit([0, 1, 2, 3, 4], [1, 2, 2, 4, 5]);
      expect(fit.slope).to.be.closeTo(1, 1e-12);
      expect(fit.halfWidth).to.be.closeTo(0.5196, 1e-4);
      expect(tCritical95(3)).to.equal(3.182);
      expect(slopeFit([0, 1], [0, 1]).halfWidth).to.be.NaN;
    });

    it("smallest detectable rise in a failure rate matches exact Fisher answers", () => {
      // from exact arithmetic: the first c with p < 0.05 against f of n
      expect(minDetectableRateIncrease(2, 20)).to.be.closeTo(7 / 20, 1e-12);
      expect(minDetectableRateIncrease(10, 100)).to.be.closeTo(11 / 100, 1e-12);
      expect(minDetectableRateIncrease(40, 400)).to.be.closeTo(20 / 400, 1e-12);
      expect(minDetectableRateIncrease(0, 5)).to.be.closeTo(4 / 5, 1e-12);
      expect(minDetectableRateIncrease(5, 5)).to.equal(Infinity);
    });

    it("a short failure-rate run says plainly what one failure stands for", () => {
      const r = rateResolution(2, 20);
      expect(r.oneFailure).to.equal(0.05);
      expect(r.detectableIncrease).to.be.closeTo(0.35, 1e-12);
    });

    it("value resolution is the larger of the spread and the 5% tolerance", () => {
      const r = valueResolution([90, 100, 110]);
      expect(r.spreadPct).to.be.closeTo(10, 1e-9);
      expect(r.detectablePct).to.be.closeTo(10, 1e-9);
      expect(valueResolution([100, 100.5, 99.5]).detectablePct).to.equal(5);
    });

    it("only a long enough full run may give a growth verdict", () => {
      expect(growthLevel("quick", 5000, 500)).to.equal("none");
      expect(growthLevel("standard", 5000, 500)).to.equal("provisional");
      expect(growthLevel("full", 1200, 120)).to.equal("verdict");
      expect(growthLevel("full", 600, 60)).to.equal("provisional");
      expect(growthLevel("full", 1200, 10)).to.equal("provisional");
    });

    it("growth text states the interval, the threshold and how firm it is", () => {
      const fit = { n: 50, slope: 2, halfWidth: 0.5 };
      expect(describeGrowth("host", fit, "none")).to.contain("no growth verdict");
      expect(describeGrowth("host", fit, "provisional", 5)).to.contain("below 5").and.to.contain("PROVISIONAL");
      expect(describeGrowth("host", fit, "verdict", 1)).to.contain("ABOVE 1");
      expect(describeGrowth("host", fit, "verdict", 2.2)).to.contain("straddles");
    });
  });

  describe("profiles and --dry-run plans", () => {
    const tp = (profile: "quick" | "standard" | "full") => ({ profile, ...THROUGHPUT_PROFILES[profile], clients: 8, mode: "hot", contract: "returner", targetPct: 5 });
    const cold = (profile: "quick" | "standard" | "full") => ({ profile, ...COLD_PROFILES[profile], nodes: 4, maxStaggerMs: 1500, extraDelayMs: 2500, extraProbability: 0.5 });
    const mem = (profile: "quick" | "standard" | "full") => ({ profile, ...MEMORY_PROFILES[profile], nodes: 4, clients: 16, idle: 10, sampleInterval: 10, reps: 1 });

    it("formats durations", () => {
      expect(human(75)).to.equal("75 s");
      expect(human(600)).to.equal("10 min");
      expect(human(4000)).to.equal("1 h 07 min");
    });

    it("parses node lists", () => {
      expect(parseNodeList("1,4,8")).to.deep.equal([1, 4, 8]);
      expect(() => parseNodeList("4,x")).to.throw("--nodes");
      expect(() => parseNodeList("0")).to.throw("--nodes");
    });

    it("an explicit flag beats the profile, the profile beats the flag default", () => {
      const flags: any = { profile: "standard", duration: 60, reps: 3 };
      applyProfile(flags, new Set(["reps"]), { quick: {}, standard: { duration: 150, reps: 9 }, full: {} });
      expect(flags.duration).to.equal(150);
      expect(flags.reps).to.equal(3);
    });

    it("throughput plans state runs, durations, estimates and limits for each profile", () => {
      const quick = planThroughput(tp("quick"));
      expect(quick).to.contain("1, 4 nodes").and.to.contain("6 runs in all").and.to.contain("60 s of load, the first 20 s excluded, so 40 s measured");
      expect(quick).to.contain("9 min (estimate from the plan").and.to.contain("not measured");
      expect(quick).to.contain("+/-10%");
      const standard = planThroughput(tp("standard"));
      expect(standard).to.contain("12 min to 18 min").and.to.contain("early stop: after round 2");
      const full = planThroughput(tp("full"));
      expect(full).to.contain("10 runs in all").and.to.contain("29 min").and.to.contain("early stop: off");
    });

    it("cold-start plans give the run count, the estimate and what the count cannot resolve", () => {
      const quick = planColdStart(cold("quick"));
      expect(quick).to.contain("20 fresh 4-node networks").and.to.contain("3 min (estimate").and.to.contain("one failure here stands for 5.0%");
      expect(quick).to.contain("about 35 points higher").and.to.contain("2% failure needs hundreds of runs");
      expect(planColdStart(cold("standard"))).to.contain("100 fresh").and.to.contain("17 min");
      expect(planColdStart(cold("full"))).to.contain("400 fresh").and.to.contain("1 h 07 min");
    });

    it("memory plans say whether growth can be called", () => {
      const quick = planMemory(mem("quick"));
      expect(quick).to.contain("5 min (estimate").and.to.contain("plateau only: no growth verdict");
      const standard = planMemory(mem("standard"));
      expect(standard).to.contain("14 min").and.to.contain("provisional growth estimate");
      const full = planMemory(mem("full"));
      expect(full).to.contain("26 min").and.to.contain("a growth verdict per role");
    });
  });

  describe("/proc parsing", () => {
    it("reads kB values from a status file", () => {
      const status = "Name:\tnode\nVmRSS:\t  123456 kB\nRssAnon:\t   100000 kB\nRssFile:\t 23000 kB\n";
      expect(statusKb(status, "VmRSS")).to.equal(123456);
      expect(statusKb(status, "RssAnon")).to.equal(100000);
      expect(statusKb(status, "VmSwap")).to.equal(0);
    });

    it("reads ppid and cpu ticks from a stat line, even with spaces and brackets in the name", () => {
      const tail = "S 42 1 1 0 -1 4194560 100 0 0 0 7 5 0 0 20 0 1 0 12345 1000 200";
      expect(parseStat(`1234 (node) ${tail}`)).to.deep.equal({ ppid: 42, cpuTicks: 12 });
      expect(parseStat(`1234 (my (odd) name) ${tail}`)).to.deep.equal({ ppid: 42, cpuTicks: 12 });
      expect(parseStat("garbage")).to.equal(undefined);
    });

    it("tells roles apart by command line", () => {
      const node = "/usr/bin/node";
      expect(classifyRole([node, "/x/packages/activeledger/lib/index.js"], true, false)).to.equal("host");
      expect(classifyRole([node, "/x/anything.js"], false, true)).to.equal("storage");
      expect(classifyRole([node, "/x/anything.js"], false, false, true)).to.equal("restore");
      expect(classifyRole([node, "/x/packages/network/lib/process.js"], false, false)).to.equal("worker");
      expect(classifyRole([node, "/x/packages/restore/lib/index.js"], false, false)).to.equal("restore");
      expect(classifyRole([node, "/x/packages/storage/lib/selfhost.js"], false, false)).to.equal("storage");
      expect(classifyRole(["sleep", "5"], false, false)).to.equal("other");
    });

    const row = (node: number, pid: number, role: ProcRow["role"], rssKb: number, anonKb: number, cpuTicks: number): ProcRow => ({ node, pid, role, rssKb, anonKb, cpuTicks });

    it("averages memory per role and totals it", () => {
      const m = memoryByRole([row(0, 1, "host", 102400, 51200, 0), row(1, 2, "host", 204800, 102400, 0), row(0, 3, "worker", 1024, 512, 0)]);
      expect(m.host).to.deep.equal({ count: 2, rssMb: 150, anonMb: 75, totalRssMb: 300 });
      expect(m.worker!.count).to.equal(1);
      expect(m.storage).to.equal(undefined);
    });

    it("sums CPU deltas per role and ignores processes missing from either sample", () => {
      const before = [row(0, 1, "host", 0, 0, 100), row(0, 2, "worker", 0, 0, 50), row(0, 3, "worker", 0, 0, 10)];
      const after = [row(0, 1, "host", 0, 0, 300), row(0, 2, "worker", 0, 0, 150), row(0, 9, "worker", 0, 0, 5000)];
      const cpu = cpuSecondsByRole(before, after, 100);
      expect(cpu.host).to.equal(2);
      expect(cpu.worker).to.equal(1);
    });
  });

  describe("load gate", () => {
    const fake = (loads: number[]) => {
      let t = 0;
      let i = 0;
      return {
        read: () => ({ load1: loads[Math.min(i++, loads.length - 1)], load5: 0, load15: 0 }),
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      };
    };

    it("returns once the load has stayed under the threshold long enough", async () => {
      const f = fake([3, 3, 1, 1, 1, 1, 1, 1, 1, 1]);
      const r = await waitForQuiet({ maxLoad: 1.5, quietSeconds: 4, timeoutSeconds: 100, pollMs: 1000, ...f });
      expect(r.quiet).to.equal(true);
      expect(r.waitedSeconds).to.equal(6);
    });

    it("a spike restarts the quiet period", async () => {
      const f = fake([1, 1, 5, 1, 1, 1, 1, 1, 1]);
      const r = await waitForQuiet({ maxLoad: 1.5, quietSeconds: 3, timeoutSeconds: 100, pollMs: 1000, ...f });
      expect(r.quiet).to.equal(true);
      // quiet again from the 4th reading (t=3) to t=6
      expect(r.waitedSeconds).to.equal(6);
    });

    it("gives up at the timeout without throwing", async () => {
      const f = fake([9]);
      const r = await waitForQuiet({ maxLoad: 1.5, quietSeconds: 3, timeoutSeconds: 10, pollMs: 1000, ...f });
      expect(r.quiet).to.equal(false);
      expect(r.waitedSeconds).to.equal(10);
      expect(r.load.load1).to.equal(9);
    });
  });

  describe("JSONL results", () => {
    it("appends one record per line and reads them back", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stress-lib-"));
      try {
        const file = path.join(dir, "nested", "r.jsonl");
        appendRecord(file, { tool: "throughput", kind: "run", n: 1 });
        appendRecord(file, { tool: "throughput", kind: "run", n: 2 });
        const back = readRecords<any>(file);
        expect(back.map((r) => r.n)).to.deep.equal([1, 2]);
        expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).to.have.length(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("skips blank lines and names the line of a bad one", () => {
      expect(parseJsonl('{"a":1}\n\n{"a":2}\n')).to.have.length(2);
      expect(() => parseJsonl('{"a":1}\nnot json\n', "f.jsonl")).to.throw("f.jsonl: line 2");
    });
  });

  describe("compare", () => {
    const run = (tps: number, p99Ms: number, extra: Partial<BaseRecord> = {}): BaseRecord => ({
      tool: "throughput",
      kind: "run",
      ts: "",
      group: "nodes=4",
      tps,
      p50Ms: p99Ms / 4,
      p99Ms,
      failedTx: 0,
      ...extra,
    });
    const series = (tps: number[], p99: number[]) => tps.map((t, i) => run(t, p99[i]));

    it("a difference inside the spread is the same", () => {
      const base = series([100, 110, 90, 105, 95], [200, 220, 180, 210, 190]);
      const cand = series([96, 104, 92, 99, 101], [205, 215, 195, 225, 185]);
      // claimPct is set wide here: this test is about the spread rule only
      const r = compareRecords(base, cand, { claimPct: 100 });
      expect(r.worse).to.equal(false);
      expect(r.inconclusive).to.equal(false);
      expect(r.metrics.every((m) => m.verdict === "same")).to.equal(true);
    });

    it("a result inside the spread is inconclusive, not a pass, when the spread is coarser than the claim", () => {
      // spread of about 10%: a 5% regression could hide in it
      const base = series([100, 110, 90, 105, 95], [200, 220, 180, 210, 190]);
      const cand = series([96, 104, 92, 99, 101], [205, 215, 195, 225, 185]);
      const r = compareRecords(base, cand);
      expect(r.worse).to.equal(false);
      expect(r.inconclusive).to.equal(true);
      expect(r.metrics.find((m) => m.metric === "tx/s")!.verdict).to.equal("inconclusive");
      expect(formatReport(r)).to.contain("inconclusive, rerun with a longer profile");
    });

    it("fewer than 3 runs on a side is inconclusive", () => {
      const r = compareRecords(series([100, 100], [100, 100]), series([100, 100], [100, 100]));
      expect(r.inconclusive).to.equal(true);
    });

    it("tight runs are a finding: same, and not inconclusive", () => {
      const r = compareRecords(series([100, 101, 99], [100, 101, 99]), series([100, 100, 101], [100, 100, 101]));
      expect(r.worse).to.equal(false);
      expect(r.inconclusive).to.equal(false);
      expect(formatReport(r)).to.contain("fine enough to say so");
    });

    it("a quick memory run contributes no growth figures", () => {
      const quick: BaseRecord = { tool: "memory", kind: "run", ts: "", group: "g", growthVerdict: "none", rssMb: { host: 100 }, growthMbPer10k: { host: 9 } };
      expect(extractMetrics(quick).map((m) => m.name)).to.deep.equal(["rss.host"]);
    });

    it("a drop larger than the spread is worse", () => {
      const base = series([100, 101, 99, 100, 100], [200, 201, 199, 200, 200]);
      const cand = series([70, 71, 69, 70, 70], [200, 201, 199, 200, 200]);
      const r = compareRecords(base, cand);
      expect(r.worse).to.equal(true);
      const tps = r.metrics.find((m) => m.metric === "tx/s")!;
      expect(tps.verdict).to.equal("worse");
      expect(tps.delta).to.equal(-30);
      expect(r.metrics.find((m) => m.metric === "p99")!.verdict).to.equal("same");
    });

    it("higher p99 is worse, lower is better", () => {
      const base = series([100, 100, 100], [100, 101, 99]);
      expect(compareRecords(base, series([100, 100, 100], [150, 151, 149])).worse).to.equal(true);
      const better = compareRecords(base, series([100, 100, 100], [60, 61, 59]));
      expect(better.worse).to.equal(false);
      expect(better.metrics.find((m) => m.metric === "p99")!.verdict).to.equal("better");
    });

    it("a wide baseline spread forgives a big difference", () => {
      const base = series([50, 150, 100, 60, 140], [200, 200, 200, 200, 200]);
      const cand = series([70, 71, 72, 69, 70], [200, 200, 200, 200, 200]);
      expect(compareRecords(base, cand).worse).to.equal(false);
    });

    it("the tolerance and the absolute floor apply when the spread is zero", () => {
      expect(compareSamples([100, 100, 100], [96, 96, 96], "higher").verdict).to.equal("same");
      expect(compareSamples([100, 100, 100], [90, 90, 90], "higher").verdict).to.equal("worse");
      expect(compareSamples([1, 1, 1], [2, 2, 2], "lower", 5).verdict).to.equal("same");
    });

    it("an uncommitted transaction in the candidate is worse", () => {
      const base = series([100, 100, 100], [100, 100, 100]);
      const cand = [run(100, 100), run(100, 100), run(100, 100, { failedTx: 3 })];
      const r = compareRecords(base, cand);
      expect(r.worse).to.equal(true);
      expect(r.notes.join("\n")).to.contain("uncommitted");
    });

    it("compares only groups present on both sides", () => {
      const r = compareRecords([run(100, 100, { group: "nodes=1" })], [run(10, 1000, { group: "nodes=8" })]);
      expect(r.worse).to.equal(false);
      expect(r.metrics).to.have.length(0);
      expect(r.notes.join("\n")).to.contain("nothing to compare");
    });

    it("ignores summary records", () => {
      const base = series([100, 100, 100], [100, 100, 100]);
      const r = compareRecords([...base, { ...run(1, 1), kind: "summary" }], base);
      expect(r.worse).to.equal(false);
    });

    it("compares cold-start runs as failure rates with Fisher's exact test", () => {
      const cold = (pass: boolean): BaseRecord => ({ tool: "cold-start", kind: "run", ts: "", group: "nodes=4", pass });
      const many = (fails: number, runs: number) => Array.from({ length: runs }, (_, i) => cold(i >= fails));
      const clear = compareRecords(many(0, 30), many(10, 30));
      expect(clear.worse).to.equal(true);
      expect(clear.rates[0].p).to.be.below(0.05);
      // 3/30 against 4/30 cannot be told apart
      const noise = compareRecords(many(3, 30), many(4, 30), { claimPoints: 100 });
      expect(noise.worse).to.equal(false);
      expect(noise.rates[0].verdict).to.equal("same");
      // with the default claim (10 points) 30 runs cannot rule a rise out
      const coarse = compareRecords(many(3, 30), many(4, 30));
      expect(coarse.rates[0].verdict).to.equal("inconclusive");
      expect(coarse.inconclusive).to.equal(true);
      // fewer failures is not worse
      expect(compareRecords(many(10, 30), many(0, 30)).worse).to.equal(false);
    });

    it("extracts memory metrics by role", () => {
      const names = extractMetrics({
        tool: "memory",
        kind: "run",
        ts: "",
        group: "g",
        rssMb: { host: 100, worker: 50 },
        growthMbPer10k: { host: 0.4 },
        cpuMsPerTx: { worker: 3 },
        tps: 80,
      }).map((m) => m.name);
      expect(names).to.have.members(["rss.host", "rss.worker", "growth.host", "cpu.worker", "tx/s"]);
    });

    it("memory growth beyond the spread is worse", () => {
      const mem = (growth: number, rss: number): BaseRecord => ({ tool: "memory", kind: "run", ts: "", group: "g", rssMb: { host: rss }, growthMbPer10k: { host: growth } });
      const base = [mem(0.1, 200), mem(0.2, 201), mem(0.15, 199)];
      expect(compareRecords(base, [mem(6, 200), mem(6.2, 201), mem(5.9, 199)]).worse).to.equal(true);
      expect(compareRecords(base, [mem(0.3, 202), mem(0.1, 200), mem(0.2, 201)]).worse).to.equal(false);
    });
  });

  describe("flag parser", () => {
    const specs: FlagSpec[] = [
      { name: "nodes", type: "number", default: 4, description: "" },
      { name: "base-port", type: "number", default: 5510, description: "" },
      { name: "mode", type: "string", default: "hot", choices: ["hot", "unique"], description: "" },
      { name: "gate", type: "boolean", default: true, description: "" },
      { name: "min-tps", type: "number", description: "" },
    ];

    it("applies defaults and leaves optional thresholds undefined", () => {
      const { flags } = parseFlags(specs, []);
      expect(flags).to.deep.equal({ nodes: 4, basePort: 5510, mode: "hot", gate: true });
      expect(flags.minTps).to.equal(undefined);
    });

    it("accepts --flag value, --flag=value and --no-flag", () => {
      const { flags } = parseFlags(specs, ["--nodes", "8", "--base-port=5610", "--mode", "unique", "--no-gate", "--min-tps", "12.5"]);
      expect(flags).to.deep.equal({ nodes: 8, basePort: 5610, mode: "unique", gate: false, minTps: 12.5 });
    });

    it("rejects unknown flags, bad numbers, bad choices and missing values", () => {
      expect(() => parseFlags(specs, ["--nope"])).to.throw(UsageError, "unknown flag --nope");
      expect(() => parseFlags(specs, ["--nodes", "four"])).to.throw(UsageError, "needs a number");
      expect(() => parseFlags(specs, ["--mode", "warm"])).to.throw(UsageError, "must be one of");
      expect(() => parseFlags(specs, ["--nodes"])).to.throw(UsageError, "needs a value");
      expect(() => parseFlags(specs, ["stray"])).to.throw(UsageError, "unexpected argument");
    });

    it("camel-cases names with digits (--max-growth-mb-per-10k)", () => {
      const spec: FlagSpec[] = [{ name: "max-growth-mb-per-10k", type: "number", description: "" }];
      expect(parseFlags(spec, ["--max-growth-mb-per-10k", "5"]).flags.maxGrowthMbPer10k).to.equal(5);
    });

    it("recognises --help and collects positionals when allowed", () => {
      expect(parseFlags(specs, ["--help"]).help).to.equal(true);
      expect(parseFlags(specs, ["a.jsonl", "--nodes", "2", "b.jsonl"], true).positionals).to.deep.equal(["a.jsonl", "b.jsonl"]);
    });
  });

  describe("harness config merge", () => {
    it("merges nested plain objects instead of replacing them", () => {
      const config: Record<string, unknown> = { db: { selfhost: { port: 1, cache: false }, other: 1 }, cpus: 4 };
      deepMerge(config, { db: { selfhost: { cache: true } }, extra: { a: 1 } });
      expect(config).to.deep.equal({ db: { selfhost: { port: 1, cache: true }, other: 1 }, cpus: 4, extra: { a: 1 } });
    });

    it("replaces arrays and scalars, and does not share the source's objects", () => {
      const source = { list: [3], n: null, nested: { x: 1 } };
      const config: Record<string, unknown> = { list: [1, 2], n: 5 };
      deepMerge(config, source);
      expect(config.list).to.deep.equal([3]);
      expect(config.n).to.equal(null);
      expect(config.nested).to.deep.equal({ x: 1 });
      expect(config.nested).to.not.equal(source.nested);
    });
  });
});
