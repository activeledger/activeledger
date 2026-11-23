import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript-api";
import { AdvisoryLookup, checkDependencies, Import } from "./deps";
import { findDuplicates } from "./duplicates";
import { RULES } from "./rules";
import { atLeast, band, countBySeverity, fileScore, overallScore } from "./score";
import { FileReport, Finding, Report, Severity, SEVERITIES } from "./types";

const EXTENSIONS = /\.(ts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", "es", "build", "coverage"]);
const MAX_BYTES = 1024 * 1024;

export interface AuditOptions {
  offline?: boolean;
  /** Rule ids to run (all when empty) */
  only?: string[];
  /** Rule ids to leave out */
  skip?: string[];
  lookup?: AdvisoryLookup;
}

/** Contract files under a file or folder, in a stable order */
export const collect = (target: string, notes: string[] = []): string[] => {
  const out: string[] = [];
  const visit = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch (e: any) {
      notes.push(`cannot read ${p}: ${e.message}`);
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) if (!SKIP_DIRS.has(name) && !name.startsWith(".")) visit(path.join(p, name));
    } else if (EXTENSIONS.test(p) && !p.endsWith(".d.ts")) {
      if (st.size > MAX_BYTES) notes.push(`skipped ${p}: over ${MAX_BYTES} bytes`);
      else out.push(p);
    }
  };
  visit(target);
  return out;
};

const importsOf = (sf: ts.SourceFile): Import[] => {
  const out: Import[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push({ name: n.moduleSpecifier.text, line: line(n) });
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push({ name: n.moduleSpecifier.text, line: line(n) });
    else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && ((ts.isIdentifier(n.expression) && n.expression.text === "require") || n.expression.kind === ts.SyntaxKind.ImportKeyword)) out.push({ name: n.arguments[0].text, line: line(n) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

/** Run every rule on one source text (the path decides only the language and the name in the report) */
export const auditSource = (file: string, text: string, opts: AuditOptions = {}): { findings: Finding[]; imports: Import[] } => {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (opts.only && opts.only.length && !opts.only.includes(rule.id)) continue;
    if (opts.skip && opts.skip.includes(rule.id)) continue;
    rule.run({
      sf,
      text,
      report: (node, message, fix, severity) => {
        const line = typeof node === "number" ? node : sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        findings.push({ file, line, severity: severity || rule.severity, group: rule.group, rule: rule.id, message, fix });
      },
    });
  }
  return { findings, imports: importsOf(sf) };
};

/** Audit the given files (already collected) */
export const auditFiles = async (paths: string[], opts: AuditOptions = {}): Promise<Report> => {
  const notes: string[] = [];
  const sources: { file: string; text: string; imports: Import[] }[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const file of paths) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e: any) {
      notes.push(`cannot read ${file}: ${e.message}`);
      continue;
    }
    const { findings, imports } = auditSource(file, text, opts);
    byFile.set(file, findings);
    sources.push({ file, text, imports });
  }

  const duplicates = findDuplicates(sources);
  for (const d of duplicates) {
    for (const [self, other] of [[d.a, d.b], [d.b, d.a]] as const) {
      byFile.get(self.file)!.push({
        file: self.file, line: self.from, severity: "low", group: "duplicate", rule: "duplicate-code",
        message: `${d.lines} lines (${self.from}-${self.to}) repeat ${path.basename(other.file)} ${other.from}-${other.to}`, fix: "Move the shared code into one function or file.",
      });
    }
  }

  const deps = await checkDependencies(sources, { offline: opts.offline, lookup: opts.lookup });
  notes.push(...deps.notes);
  for (const f of deps.findings) byFile.get(f.file)?.push(f);

  const files: FileReport[] = sources.map(({ file }) => {
    const findings = byFile.get(file)!.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.line - b.line);
    const score = fileScore(findings);
    return { file, findings, score, band: band(score) };
  });
  return { files, duplicates, counts: countBySeverity(files), overall: overallScore(files), notes };
};

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** Plain-text tables: one per file, then the summary */
export const render = (report: Report, root = process.cwd()): string => {
  const out: string[] = [];
  const rel = (f: string) => path.relative(root, f) || f;
  for (const f of report.files) {
    out.push(rel(f.file));
    if (!f.findings.length) out.push("  (no findings)");
    else {
      const rows = f.findings.map((x) => [x.line ? String(x.line) : "-", x.severity, x.rule, x.message, x.fix]);
      const head = ["Line", "Severity", "Rule", "Finding", "Fix"];
      const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => Math.min(r[i].length, i >= 3 ? 70 : 30))));
      const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
      out.push("  " + head.map((h, i) => pad(h, w[i])).join("  "));
      for (const r of rows) out.push("  " + r.map((c, i) => pad(cut(c, w[i]), w[i])).join("  "));
    }
    const c = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
    f.findings.forEach((x) => c[x.severity]++);
    out.push(`  Risk ${f.score}/100 (${f.band})   critical ${c.critical}  high ${c.high}  medium ${c.medium}  low ${c.low}`, "");
  }
  if (report.duplicates.length) {
    out.push("Duplicate code");
    for (const d of report.duplicates) out.push(`  ${rel(d.a.file)} ${d.a.from}-${d.a.to}  =  ${rel(d.b.file)} ${d.b.from}-${d.b.to}  (${d.lines} lines)`);
    out.push("");
  }
  const k = report.counts;
  out.push("Summary");
  out.push(`  Files ${report.files.length}   Findings ${k.critical + k.high + k.medium + k.low}   Critical ${k.critical}  High ${k.high}  Medium ${k.medium}  Low ${k.low}`);
  out.push(`  Overall risk ${report.overall.score}/100 (${report.overall.band})   worst file ${report.overall.worst}, average ${report.overall.average}`);
  for (const n of report.notes) out.push(`  note: ${n}`);
  return out.join("\n");
};

export interface AuditFlags {
  json?: boolean;
  offline?: boolean;
  failOn?: string;
  rules?: boolean;
  only?: string;
  skip?: string;
}

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** `activeledger audit <file|folder>`: 0 clean (or under --fail-on), 1 a finding at or over --fail-on, 2 bad use */
export const auditCommand = async (target: string | undefined, flags: AuditFlags, out: { log(t: string): void; error(t: string): void } = console, lookup?: AdvisoryLookup): Promise<number> => {
  if (flags.rules) {
    for (const r of RULES) out.log(`${pad(r.id, 20)} ${pad(r.group, 14)} ${pad(r.severity, 9)} ${r.about}`);
    out.log(`${pad("duplicate-code", 20)} ${pad("duplicate", 14)} ${pad("low", 9)} blocks of 6 or more lines that appear twice`);
    out.log(`${pad("(advisories)", 20)} ${pad("dependency", 14)} ${pad("by advisory", 9)} imports checked against the npm advisory database; --offline skips it`);
    return 0;
  }
  if (!target) {
    out.error("usage: activeledger audit <file|folder> [--json] [--offline] [--fail-on critical|high|medium|low] [--only a,b] [--skip a,b]");
    return 2;
  }
  if (flags.failOn && !SEVERITIES.includes(flags.failOn as Severity)) {
    out.error(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
    return 2;
  }
  const notes: string[] = [];
  if (!fs.existsSync(target)) {
    out.error(`${target} does not exist`);
    return 2;
  }
  const paths = collect(target, notes);
  if (!paths.length) {
    out.error(`no .ts or .js files under ${target}`);
    return 2;
  }
  const report = await auditFiles(paths, { offline: flags.offline, only: list(flags.only), skip: list(flags.skip), lookup });
  report.notes.unshift(...notes);
  out.log(flags.json ? JSON.stringify(report, null, 2) : render(report));
  if (flags.failOn && report.files.some((f) => f.findings.some((x) => atLeast(x.severity, flags.failOn as Severity)))) return 1;
  return 0;
};
