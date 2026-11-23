import * as fs from "fs";
import * as path from "path";
import { builtinModules } from "module";
import { Finding, Severity } from "./types";

export interface Import {
  name: string;
  line: number;
}

/** Looks up advisories: { package: [versions] } in, { package: [advisory] } out */
export type AdvisoryLookup = (query: Record<string, string[]>) => Promise<Record<string, any[]>>;

const REGISTRY = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

/** Only package names and versions leave the machine, never source */
export const registryLookup: AdvisoryLookup = async (query) => {
  const res = await fetch(REGISTRY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  return (await res.json()) as Record<string, any[]>;
};

/** "lodash/fp" -> "lodash", "@scope/pkg/sub" -> "@scope/pkg"; undefined for relative, node: and built-in modules and the toolkits */
export const packageOf = (spec: string): string | undefined => {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("file:")) return undefined;
  if (/^@activeledger\//.test(spec)) return undefined;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (builtinModules.includes(name)) return undefined;
  return name;
};

const readJson = (p: string): any => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

/** The version of `name` as seen from `dir`: installed first, then declared in the nearest package.json */
export const resolveVersion = (dir: string, name: string): { version?: string; declared?: string } => {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const installed = readJson(path.join(d, "node_modules", ...name.split("/"), "package.json"));
    if (installed && typeof installed.version === "string") return { version: installed.version };
    const pkg = readJson(path.join(d, "package.json"));
    if (pkg) {
      const declared = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].map((s) => s && s[name]).find((v) => typeof v === "string");
      if (declared) return { declared };
    }
    if (path.dirname(d) === d) return {};
  }
};

const EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const SEVERITY: Record<string, Severity> = { critical: "critical", high: "high", moderate: "medium", medium: "medium", low: "low", info: "low" };

export interface DepResult {
  findings: Finding[];
  notes: string[];
}

/** Dependency findings for every file's imports: unpinned or unknown versions, and registry advisories */
export const checkDependencies = async (
  files: { file: string; imports: Import[] }[],
  opts: { offline?: boolean; lookup?: AdvisoryLookup }
): Promise<DepResult> => {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const query: Record<string, Set<string>> = {};
  const uses: { file: string; line: number; name: string; version: string }[] = [];

  for (const f of files) {
    const seen = new Set<string>();
    for (const imp of f.imports) {
      const name = packageOf(imp.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const { version, declared } = resolveVersion(path.dirname(f.file), name);
      let use = version;
      if (!use && declared) {
        if (!EXACT.test(declared)) {
          findings.push({ file: f.file, line: imp.line, severity: "medium", group: "dependency", rule: "unpinned-version", message: `${name} is declared as "${declared}", so the version that runs is not known`, fix: `Pin an exact version of ${name}.` });
        }
        const m = /\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?/.exec(declared);
        use = m ? m[0] : undefined;
      }
      if (!use) {
        findings.push({ file: f.file, line: imp.line, severity: "low", group: "dependency", rule: "unknown-version", message: `no version of ${name} found next to the file`, fix: "Add a package.json with the exact version." });
        continue;
      }
      uses.push({ file: f.file, line: imp.line, name, version: use });
      (query[name] || (query[name] = new Set())).add(use);
    }
  }

  if (!uses.length) return { findings, notes };
  if (opts.offline) {
    notes.push("dependency advisories not checked (--offline)");
    return { findings, notes };
  }
  try {
    const body: Record<string, string[]> = {};
    for (const k of Object.keys(query)) body[k] = [...query[k]];
    const advisories = await (opts.lookup || registryLookup)(body);
    for (const u of uses) {
      for (const a of advisories[u.name] || []) {
        findings.push({
          file: u.file, line: u.line, severity: SEVERITY[String(a.severity).toLowerCase()] || "medium", group: "dependency",
          rule: String(a.url || a.id || "advisory").split("/").pop() || "advisory",
          message: `${u.name} ${u.version}: ${a.title || "known advisory"}${a.vulnerable_versions ? ` (affects ${a.vulnerable_versions})` : ""}`,
          fix: `Upgrade ${u.name} to a version outside ${a.vulnerable_versions || "the affected range"}.`,
        });
      }
    }
  } catch (e: any) {
    notes.push(`dependency advisories not checked: ${e && e.message ? e.message : e}`);
  }
  return { findings, notes };
};
