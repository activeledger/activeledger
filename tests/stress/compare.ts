/**
 * Compare tool: reads a baseline and a candidate JSONL file produced by the
 * other stress tools and exits non-zero if the candidate is worse than the
 * baseline by more than the measured spread. See
 * docs/guide/operate/stress-tests.md.
 *
 *   npm run stress:compare -- baseline.jsonl candidate.jsonl
 */

import { FlagSpec, UsageError, helpText, parseFlags } from "./lib/cli";
import { compareRecords, formatReport } from "./lib/compare";
import { readRecords } from "./lib/results";

const SPECS: FlagSpec[] = [
  { name: "tolerance-pct", type: "number", default: 5, description: "also ignore differences smaller than this percent of the baseline median" },
  { name: "claim-pct", type: "number", default: 5, description: "the relative difference (percent) the runs must be fine enough to rule out; otherwise the result is inconclusive" },
  { name: "claim-points", type: "number", default: 10, description: "the same for cold-start failure rates, in percentage points" },
  { name: "fail-on-regression", type: "boolean", default: false, description: "exit 1 if the candidate is worse beyond the spread (and 3 if inconclusive); without it the tool prints the verdict and exits 0" },
  { name: "allow-inconclusive", type: "boolean", default: false, description: "with --fail-on-regression: exit 0 instead of 3 when the result is inconclusive" },
  { name: "alpha", type: "number", default: 0.05, description: "significance level for cold-start failure rates (Fisher exact test)" },
];

const HELP = `Usage: npm run stress:compare -- [flags] <baseline.jsonl> <candidate.jsonl>

For each tool and settings group present in both files, compares tx/s, p50 and
p99 (throughput), and per-role RSS, growth and CPU per tx (memory), by the
median and the interquartile range of the runs. The candidate is worse on a
metric when it is on the bad side of the baseline's median by more than the
largest of: either side's IQR, --tolerance-pct of the baseline median, and a
small absolute floor. Cold-start files are compared as failure rates with
Fisher's exact test. A candidate run with an uncommitted transaction is worse
than a baseline without one.

Only runs of the same tool and the same settings are compared; more runs on
each side (collected interleaved, see the guide) give a more honest spread.

A "same" result is only believed if the runs were fine enough to have shown a
difference of --claim-pct (relative) or --claim-points (failure rates) and each side
has at least 3 runs; otherwise the tool says INCONCLUSIVE and asks for a longer
profile rather than declaring no regression.

Exit status: 0 whenever the comparison ran and the report was printed, whatever the
verdict. With --fail-on-regression: 1 if the candidate is worse beyond the spread,
3 if the result is inconclusive (0 with --allow-inconclusive). 2 on a usage error
or an unreadable file.`;

try {
  const { flags, help, positionals: files } = parseFlags(SPECS, process.argv.slice(2), true);
  if (help) {
    console.log(helpText("stress:compare", "Compare two stress result files by their spread.", SPECS, HELP));
    process.exit(0);
  }
  if (files.length !== 2) throw new UsageError("expected exactly two files: <baseline.jsonl> <candidate.jsonl> (try --help)");
  const report = compareRecords(readRecords(files[0]), readRecords(files[1]), { tolerancePct: flags.tolerancePct, alpha: flags.alpha, claimPct: flags.claimPct, claimPoints: flags.claimPoints });
  console.log(`baseline:  ${files[0]}\ncandidate: ${files[1]}`);
  console.log(formatReport(report));
  process.exit(!flags.failOnRegression ? 0 : report.worse ? 1 : report.inconclusive && !flags.allowInconclusive ? 3 : 0);
} catch (e: any) {
  console.error(`stress:compare: ${e.message}`);
  process.exit(2);
}
