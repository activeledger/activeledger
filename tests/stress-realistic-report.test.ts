import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildHtml } from "./stress/lib/realistic-report";

/**
 * The one page PDF a customer reads is built from a results file, so what it
 * shows is worth pinning: the headline is the highest step the network held,
 * only held steps appear, confirmed is never shown above what was sent, and a
 * rate with no result reads N/A. (The load run itself is a stress tool, run on
 * demand and never part of npm test: see docs/guide/stress/tools.md.)
 */
describe("stress:realistic report (the one page summary)", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-realistic-report-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meta = (contract: string) => ({ kind: "meta", ts: "2026-11-05T10:00:00.000Z", commit: "abc1234", nodes: 4, cpus: 24, contract });
  const run = (offered: number, committed: number, p99: number, sustained: boolean) => ({
    kind: "run", offeredTps: offered, committedTps: committed, p50Ms: 5, p99Ms: p99, sustained,
    loadBefore: { load1: 1 }, loadAfter: { load1: 9 },
  });
  const file = (name: string, records: object[]) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return f;
  };

  const reads = () => file("reads.jsonl", [meta("no-write"), run(300, 302.6, 9, true), run(1100, 1103.8, 32, true), run(1300, 824, 6970, false)]);
  const writes = () => file("writes.jsonl", [meta("returner"), run(300, 306.4, 12, true), run(800, 798.4, 388, true), run(900, 319.9, 20000, false)]);

  it("headlines the highest step each kind held", () => {
    const html = buildHtml([reads(), writes()]);
    expect(html).to.contain("Reads");
    expect(html).to.contain("Writes");
    expect(html).to.match(/1,100 <small>per second/);
    expect(html).to.match(/798 <small>per second/);
    expect(html).to.contain("388 ms");
    expect(html).to.contain("32 ms");
  });

  it("shows only steps the network held", () => {
    const html = buildHtml([reads(), writes()]);
    // the collapsed steps (1300 reads, 900 writes) appear nowhere, not even their latency
    expect(html).to.not.contain("1,300");
    expect(html).to.not.contain("824");
    expect(html).to.not.contain("6.9 s");
    expect(html).to.not.contain("20.0 s");
    expect(html).to.not.contain("319");
  });

  it("never shows confirmed above what was sent", () => {
    const html = buildHtml([reads()]);
    expect(html).to.not.contain("1,104");
    expect(html).to.not.contain("1103");
  });

  it("marks a rate one kind has no result for as N/A and explains it", () => {
    const html = buildHtml([reads(), writes()]);
    expect(html).to.contain("N/A");
    expect(html).to.contain("N/A means no result is shown at that rate");
  });

  it("uses no red for a result: there are no failures on the page", () => {
    const html = buildHtml([reads(), writes()]);
    expect(html).to.not.contain("#a40e26");
    expect(html).to.not.contain("#d1242f");
  });

  it("says what was tested, in positive terms, and does not warn that heavier contracts do worse", () => {
    const html = buildHtml([reads(), writes()]);
    expect(html).to.contain("Reads and writes were both tested");
    expect(html).to.contain("peak load test");
    expect(html).to.contain("dedicated servers built for the job will deliver more");
    for (const cautious of ["heavier contracts", "Treat figures as a guide", "Short test", "understate", "only a guide"]) {
      expect(html, cautious).to.not.contain(cautious);
    }
  });

  it("builds from one file with one headline", () => {
    const html = buildHtml([reads()]);
    expect(html).to.contain("Reads");
    expect(html).to.not.contain("Writes");
  });

  it("states the machine and the load it was measured under", () => {
    const html = buildHtml([reads()]);
    expect(html).to.contain("24 threads");
    expect(html).to.contain("load average up to 9");
    expect(html).to.contain("4-node network");
  });

  it("refuses a file in which no step was held, rather than print an empty page", () => {
    const bad = file("none.jsonl", [meta("no-write"), run(900, 100, 9000, false)]);
    expect(() => buildHtml([bad])).to.throw(/no step was sustained/);
  });

  it("refuses a file that is not a stress:realistic results file", () => {
    const bad = file("other.jsonl", [{ kind: "run", tool: "throughput" }]);
    expect(() => buildHtml([bad])).to.throw(/no meta record/);
  });
});
