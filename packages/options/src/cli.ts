/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import minimist from "minimist";

/**
 * Stable exit codes, the same in every Activeledger program
 */
export const ExitCode = {
  OK: 0,
  FAIL: 1,
  // A state check failed: not ready, lagging, outdated, not registered
  STATE: 2,
} as const;

export interface CliFlag {
  name: string;
  description: string;
  // boolean flags never swallow the next positional (`--json status`)
  type?: "boolean" | "value";
  // Shown in help, e.g. "<file>"
  arg?: string;
  default?: string;
  // Other spellings of the same flag (`v` for `version`)
  aliases?: string[];
  // Naming this flag runs a command (`--stop` is `stop`)
  command?: string;
  // Help group, in the order first seen
  group?: string;
  // Accepted but not listed in help (config keys that can also be flags)
  hidden?: boolean;
}

export interface CliCommand {
  name: string;
  description: string;
  // e.g. "[command]" or "<key|file>"
  usage?: string;
  // Flags only this command accepts
  flags?: CliFlag[];
}

export interface CliProgram {
  name: string;
  version: string;
  // Hollow last block in the banner, a hybrid is the link that follows
  hollow?: boolean;
  defaultCommand: string;
  commands: CliCommand[];
  flags: CliFlag[];
}

export interface CliParse {
  command: string;
  positionals: string[];
  flags: minimist.ParsedArgs;
  errors: string[];
}

/**
 * Flags every program has
 */
export const COMMON_FLAGS: CliFlag[] = [
  { name: "config", arg: "<file>", description: "Config file", group: "Common" },
  { name: "identity", arg: "<file>", description: "Identity file", default: "./.identity", group: "Common" },
  { name: "data-dir", arg: "<dir>", description: "Data directory", group: "Common" },
  { name: "host", arg: "<addr>", description: "Bind address", group: "Common" },
  { name: "port", arg: "<n>", description: "Bind port", group: "Common" },
  { name: "debug", type: "boolean", description: "Debug logging", group: "Common" },
  { name: "json", type: "boolean", description: "Machine-readable output", group: "Common" },
  { name: "quiet", type: "boolean", description: "No banner, tagline or progress display", group: "Common" },
  { name: "yes", type: "boolean", description: "Skip the confirmation on a destructive command", group: "Common" },
  { name: "help", type: "boolean", description: "Show usage for the program or the command", group: "Common" },
  { name: "version", type: "boolean", aliases: ["v"], command: "version", description: "Print the version", group: "Common" },
];

export const COMMON_COMMANDS: CliCommand[] = [
  { name: "start", description: "Run the node (the default)", flags: [
    { name: "foreground", type: "boolean", description: "Stay attached instead of writing a PID file" },
  ] },
  { name: "stop", description: "Stop the node and wait for it to exit", flags: [
    { name: "timeout", arg: "<s>", description: "Seconds to wait" },
  ] },
  { name: "restart", description: "Stop then start the node", flags: [
    { name: "timeout", arg: "<s>", description: "Seconds to wait" },
  ] },
  { name: "status", description: "Print the node's state. Exit 0 ready, 2 not ready", flags: [
    { name: "max-lag", arg: "<s>", description: "Lag beyond this exits 2" },
  ] },
  { name: "check-config", description: "Validate the config file. Exit 2 with the reason if wrong" },
  { name: "version", description: "Print the version" },
  { name: "help", usage: "[command]", description: "Same as --help" },
];

/**
 * Taglines for the help banner, a plain array so contributors can add to it
 */
export const TAGLINES: string[] = [
  "Distributed ledger, no ceremony.",
  "Every link holds.",
  "One chain, many hands.",
  "Consensus, without the committee.",
];

export const BROKEN_TAGLINES: string[] = [
  "The fork is only for display.",
  "Nothing is broken. Probably.",
];

// Edit distance where swapping two neighbours costs one ("stauts")
const levenshtein = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};

/**
 * Nearest known name, or undefined when nothing is close
 */
export const nearest = (name: string, known: string[]): string | undefined => {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const k of known) {
    const d = levenshtein(name, k);
    if (d < bestScore) {
      best = k;
      bestScore = d;
    }
  }
  return best !== undefined && bestScore <= Math.max(1, Math.floor(name.length / 3))
    ? best
    : undefined;
};

const allFlags = (program: CliProgram, command?: string): CliFlag[] => [
  ...program.flags,
  ...program.commands.flatMap((c) =>
    !command || c.name === command ? c.flags || [] : []
  ),
];

/**
 * Parse argv and check every name against the program's registry.
 * Pure: nothing is printed and nothing exits.
 */
export const parseCli = (program: CliProgram, argv: string[]): CliParse => {
  const flagSpecs = allFlags(program);
  const boolean = flagSpecs
    .filter((f) => f.type === "boolean")
    .flatMap((f) => [f.name, ...(f.aliases || [])]);
  const flags = minimist(argv, { boolean });
  const errors: string[] = [];
  const positionals = flags._.map(String);

  let command = program.defaultCommand;
  const commandNames = program.commands.map((c) => c.name);
  if (positionals.length) {
    if (commandNames.includes(positionals[0])) {
      command = positionals[0];
    } else {
      const guess = nearest(positionals[0], commandNames);
      errors.push(
        `Unknown command "${positionals[0]}"` +
          (guess ? `. Did you mean "${guess}"?` : "")
      );
    }
  } else {
    // A legacy flag such as --stop names its command
    const named = flagSpecs.find(
      (f) =>
        f.command &&
        [f.name, ...(f.aliases || [])].some((n) => flags[n] !== undefined && flags[n] !== false)
    );
    if (named) command = named.command as string;
  }

  const known = new Set<string>();
  for (const f of allFlags(program, command))
    [f.name, ...(f.aliases || [])].forEach((n) => known.add(n));
  // Registered on another command: reported as unknown for this one
  // minimist sets every declared boolean to false, so only count the ones typed
  const typed = (key: string) =>
    flags[key] !== false ||
    argv.some((a) => a === `--${key}` || a === `-${key}` || a.startsWith(`--${key}=`));
  for (const key of Object.keys(flags)) {
    if (key === "_" || known.has(key) || !typed(key)) continue;
    const guess = nearest(key, [...known]);
    errors.push(
      `Unknown flag "${key.length === 1 ? "-" : "--"}${key}"` +
        (guess ? `. Did you mean "--${guess}"?` : "")
    );
  }

  return { command, positionals, flags, errors };
};

export interface CliEnv {
  isTTY: boolean;
  noColor: boolean;
  // 0..1, injectable so the easter egg is testable
  random: () => number;
}

export const currentEnv = (): CliEnv => ({
  isTTY: !!process.stdout.isTTY,
  noColor: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "",
  random: Math.random,
});

/**
 * Banner and tagline, empty when output is not for a person
 */
export const banner = (
  program: CliProgram,
  flags: { json?: boolean; quiet?: boolean },
  env: CliEnv = currentEnv()
): string => {
  if (!env.isTTY || env.noColor || flags.json || flags.quiet) return "";
  const broken = env.random() < 1 / 50;
  const list = broken ? BROKEN_TAGLINES : TAGLINES;
  const tagline = list[Math.floor(env.random() * list.length) % list.length];
  const last = program.hollow ? "[   ]" : "[###]";
  const chain = broken ? `[###]==[###]=/=${last}` : `[###]==[###]==${last}`;
  return ` ${chain}\n   ${program.name} ${program.version}\n   ${tagline}\n\n`;
};

const flagLine = (f: CliFlag): string => {
  const left = `--${f.name}${f.arg ? " " + f.arg : ""}`;
  const alias = f.aliases?.length ? ` (-${f.aliases.join(", -")})` : "";
  return `  ${left.padEnd(28)}${f.description}${alias}${
    f.default ? ` [default: ${f.default}]` : ""
  }`;
};

/**
 * Help for the program, or for one command (no banner then)
 */
export const helpText = (
  program: CliProgram,
  command?: string,
  flags: { json?: boolean; quiet?: boolean } = {},
  env: CliEnv = currentEnv()
): string => {
  if (command) {
    const c = program.commands.find((x) => x.name === command);
    if (!c) return `Unknown command "${command}". Run "${program.name} help".\n`;
    const lines = [`Usage: ${program.name} ${c.name}${c.usage ? " " + c.usage : ""} [flags]`, "", c.description];
    if (c.flags?.length) lines.push("", "Flags:", ...c.flags.map(flagLine));
    return lines.join("\n") + "\n";
  }
  const out = [
    `Usage: ${program.name} [command] [flags]`,
    "",
    "Commands:",
    ...program.commands.map(
      (c) => `  ${(c.name + (c.usage ? " " + c.usage : "")).padEnd(28)}${c.description}`
    ),
  ];
  const groups = new Map<string, CliFlag[]>();
  for (const f of program.flags) {
    if (f.hidden) continue;
    const g = f.group || "Flags";
    groups.set(g, [...(groups.get(g) || []), f]);
  }
  for (const [g, list] of groups) out.push("", `${g}:`, ...list.map(flagLine));
  return banner(program, flags, env) + out.join("\n") + "\n";
};

/**
 * Print data for a person, or as JSON when asked
 */
export const printResult = (
  data: unknown,
  json: boolean,
  text: (d: any) => string = (d) => String(d)
): void => {
  console.log(json ? JSON.stringify(data) : text(data));
};

export interface CliOutcome {
  // Set when the layer has already dealt with argv and the program must exit
  exit?: number;
  command: string;
  flags: minimist.ParsedArgs;
  positionals: string[];
}

/**
 * Entry point for a program: handles help, version and unknown names.
 * Returns `exit` set when the program must stop before starting anything.
 */
export const runCli = (
  program: CliProgram,
  argv: string[],
  env: CliEnv = currentEnv(),
  write: (s: string, err?: boolean) => void = (s, err) =>
    (err ? process.stderr : process.stdout).write(s)
): CliOutcome => {
  const parsed = parseCli(program, argv);
  const { command, flags, positionals } = parsed;
  const base = { command, flags, positionals };

  if (parsed.errors.length) {
    write(
      parsed.errors.join("\n") + `\nRun "${program.name} help" for usage.\n`,
      true
    );
    return { ...base, exit: ExitCode.FAIL };
  }
  if (command === "help" || flags.help) {
    const target = command === "help" ? positionals[1] : command !== program.defaultCommand ? command : undefined;
    write(helpText(program, target, { json: !!flags.json, quiet: !!flags.quiet }, env));
    return { ...base, exit: ExitCode.OK };
  }
  if (command === "version") {
    write(flags.json ? JSON.stringify({ version: program.version }) + "\n" : `v${program.version}\n`);
    return { ...base, exit: ExitCode.OK };
  }
  return base;
};
