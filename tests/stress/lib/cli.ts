/**
 * A tiny flag parser, so each stress tool documents its flags once and gets
 * --help, defaults, type checks and an error on a typo for free. No
 * dependency: the repo has none for this and the need is small.
 */

export interface FlagSpec {
  /** kebab-case name, used as --name */
  name: string;
  type: "number" | "string" | "boolean";
  default?: number | string | boolean;
  description: string;
  choices?: string[];
}

export class UsageError extends Error {}

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

export type Flags = Record<string, any>;

/**
 * Parses `--flag value`, `--flag=value`, `--flag` and `--no-flag` (booleans).
 * Keys of the result are the flag names in camelCase. A flag with no default
 * and no value is undefined (used for optional thresholds). --help is always
 * accepted and gives `help: true`.
 */
export function parseFlags(
  specs: FlagSpec[],
  argv: string[],
  allowPositional = false
): { flags: Flags; help: boolean; positionals: string[]; given: Set<string> } {
  const given = new Set<string>();
  const byName = new Map(specs.map((s) => [s.name, s]));
  const flags: Flags = {};
  for (const s of specs) if (s.default !== undefined) flags[camel(s.name)] = s.default;
  const positionals: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (!allowPositional) throw new UsageError(`unexpected argument "${arg}" (try --help)`);
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    let negate = false;
    if (!byName.has(name) && name.startsWith("no-") && byName.get(name.slice(3))?.type === "boolean") {
      negate = true;
      name = name.slice(3);
    }
    const spec = byName.get(name);
    if (!spec) throw new UsageError(`unknown flag --${name} (try --help)`);
    given.add(camel(name));

    if (spec.type === "boolean") {
      flags[camel(name)] = negate ? false : inline === undefined ? true : !/^(false|0|no)$/i.test(inline);
      continue;
    }
    const raw = inline !== undefined ? inline : argv[++i];
    if (raw === undefined) throw new UsageError(`--${name} needs a value`);
    if (spec.type === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${name} needs a number, got "${raw}"`);
      flags[camel(name)] = n;
    } else {
      if (spec.choices && !spec.choices.includes(raw)) {
        throw new UsageError(`--${name} must be one of ${spec.choices.join(", ")}, got "${raw}"`);
      }
      flags[camel(name)] = raw;
    }
  }
  return { flags, help, positionals, given };
}

export function helpText(tool: string, summary: string, specs: FlagSpec[], extra = ""): string {
  const width = Math.max(...specs.map((s) => s.name.length + (s.type === "boolean" ? 0 : 8)));
  const lines = specs.map((s) => {
    const left = `--${s.name}${s.type === "boolean" ? "" : s.choices ? " <" + s.choices.join("|") + ">" : " <" + s.type + ">"}`;
    const def = s.default !== undefined ? ` (default ${s.default})` : "";
    return `  ${left.padEnd(width + 14)} ${s.description}${def}`;
  });
  return `${tool}\n\n${summary}\n\nFlags:\n${lines.join("\n")}\n  ${"--help".padEnd(width + 14)} show this text\n${extra ? "\n" + extra + "\n" : ""}`;
}

/** Runs a tool's main function: --help, usage errors (exit 2) and crashes (exit 2). */
export async function runTool(
  tool: string,
  summary: string,
  specs: FlagSpec[],
  extraHelp: string,
  main: (flags: Flags) => Promise<number>,
  profiles?: Record<ProfileName, Record<string, unknown>>,
  plan?: (flags: Flags) => string
): Promise<void> {
  let parsed: { flags: Flags; help: boolean; positionals: string[]; given: Set<string> };
  try {
    parsed = parseFlags(specs, process.argv.slice(2));
  } catch (e: any) {
    console.error(`${tool}: ${e.message}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(helpText(tool, summary, specs, extraHelp));
    process.exit(0);
  }
  if (profiles) applyProfile(parsed.flags, parsed.given, profiles);
  if (plan && parsed.flags.dryRun) {
    console.log(plan(parsed.flags));
    process.exit(0);
  }
  try {
    process.exit(await main(parsed.flags));
  } catch (e: any) {
    console.error(`${tool}: ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  }
}

export type ProfileName = "quick" | "standard" | "full";
export const PROFILE_NAMES: ProfileName[] = ["quick", "standard", "full"];

/**
 * A profile is a bundle of defaults for one tool. Flags the user gave on the
 * command line win over the profile; the profile wins over the flag's own
 * default. Sets flags.profile to the resolved name.
 */
export function applyProfile(flags: Flags, given: Set<string>, profiles: Record<ProfileName, Record<string, unknown>>): void {
  const name = flags.profile as ProfileName;
  for (const [key, value] of Object.entries(profiles[name])) {
    if (!given.has(key)) flags[key] = value;
  }
}

/** --profile, with STRESS_PROFILE in the environment as its default. */
export const PROFILE_FLAG: FlagSpec = {
  name: "profile",
  type: "string",
  choices: PROFILE_NAMES,
  default: PROFILE_NAMES.includes(process.env.STRESS_PROFILE as ProfileName) ? process.env.STRESS_PROFILE : "quick",
  description: "how long and how thorough: quick (smoke check, minutes), standard (about half an hour), full (hours); also set by STRESS_PROFILE",
};

/** A plain aligned text table: header row, then rows; the first column is left aligned. */
export function formatTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) => "  " + r.map((cell, c) => (c === 0 ? (cell ?? "").padEnd(widths[c]) : (cell ?? "").padStart(widths[c]))).join("  ");
  return [line(header), "  " + widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** Flags every tool shares. */
export const COMMON_FLAGS: FlagSpec[] = [
  PROFILE_FLAG,
  { name: "dry-run", type: "boolean", default: false, description: "print what the chosen profile would do (runs, durations, estimated time, what it can resolve) and exit; starts nothing" },
  { name: "out", type: "string", description: "JSONL file to append results to (default ./stress-results/<tool>-<time>.jsonl)" },
  { name: "label", type: "string", description: "free text stored with each record, e.g. baseline or candidate" },
  { name: "base-port", type: "number", default: 5510, description: "port of the first node; nodes use base, base+10, ... and storage uses port-1" },
  { name: "gate", type: "boolean", default: true, description: "wait for a quiet machine before starting (--no-gate to skip)" },
  { name: "max-load", type: "number", default: 1.5, description: "load gate: proceed when the 1-minute load average is below this" },
  { name: "quiet-seconds", type: "number", default: 10, description: "load gate: ... and has stayed below it this long" },
  { name: "gate-timeout", type: "number", default: 120, description: "load gate: stop waiting after this many seconds and run anyway, flagged" },
];

