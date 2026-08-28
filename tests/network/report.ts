/**
 * Live CLI progress + a final summary report for the network integration
 * test. Plain ANSI escapes, no new dependency - matches how ActiveLogger
 * already colours its own console output.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

interface CategoryStats {
  category: string;
  passed: number;
  failed: number;
  durationsMs: number[];
}

export class Report {
  private categories = new Map<string, CategoryStats>();
  private startedAt = Date.now();
  private isTty = process.stdout.isTTY === true;

  public phase(name: string): void {
    console.log(`\n${BOLD}${CYAN}== ${name} ==${RESET}`);
  }

  public info(message: string): void {
    console.log(`  ${DIM}${message}${RESET}`);
  }

  public ok(message: string): void {
    console.log(`  ${GREEN}✔${RESET} ${message}`);
  }

  public fail(message: string): void {
    console.log(`  ${RED}✖${RESET} ${message}`);
  }

  public warn(message: string): void {
    console.log(`  ${YELLOW}!${RESET} ${message}`);
  }

  /** Live, overwriting progress line - falls back to periodic plain lines when not a TTY (e.g. piped/CI output). */
  public progress(current: number, total: number, label: string): void {
    const line = `  [${current}/${total}] ${label}`;
    if (this.isTty) {
      process.stdout.write(`\r\x1b[K${line}`);
    } else if (current === total || current % 10 === 0) {
      console.log(line);
    }
  }

  public endProgress(): void {
    if (this.isTty) process.stdout.write("\n");
  }

  public record(category: string, passed: boolean, durationMs: number): void {
    let stats = this.categories.get(category);
    if (!stats) {
      stats = { category, passed: 0, failed: 0, durationsMs: [] };
      this.categories.set(category, stats);
    }
    if (passed) stats.passed++;
    else stats.failed++;
    stats.durationsMs.push(durationMs);
  }

  public summary(): boolean {
    const totalWallMs = Date.now() - this.startedAt;
    console.log(`\n${BOLD}${CYAN}== Summary ==${RESET}`);

    let allPassed = true;
    const rows: string[][] = [
      ["Category", "Passed", "Failed", "Avg ms", "Max ms"],
    ];
    // Array.from(), not for...of, over the Map's iterator - this project's
    // root tsconfig has no explicit `target` (defaults low) combined with
    // `lib: ["es2018"]` and no downlevelIteration, under which a for...of
    // loop over a true iterable like Map.values() silently iterates zero
    // times instead of erroring - a real, confirmed pitfall (reproduced
    // directly), not a hypothetical.
    for (const stats of Array.from(this.categories.values())) {
      const total = stats.passed + stats.failed;
      const avg = Math.round(stats.durationsMs.reduce((a, b) => a + b, 0) / total);
      const max = Math.max(...stats.durationsMs);
      if (stats.failed > 0) allPassed = false;
      rows.push([
        stats.category,
        String(stats.passed),
        String(stats.failed),
        String(avg),
        String(max),
      ]);
    }

    const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i].map((cell, col) => cell.padEnd(widths[col])).join("  ");
      const color = i === 0 ? BOLD : rows[i][2] !== "0" ? RED : GREEN;
      console.log(`  ${color}${line}${RESET}`);
    }

    console.log(`\n  Total wall time: ${(totalWallMs / 1000).toFixed(1)}s`);
    console.log(
      allPassed
        ? `\n${BOLD}${GREEN}ALL CHECKS PASSED${RESET}\n`
        : `\n${BOLD}${RED}SOME CHECKS FAILED${RESET}\n`
    );
    return allPassed;
  }
}
