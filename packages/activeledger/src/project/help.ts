import { banner } from "./banner";

export interface CommandHelp {
  usage: string;
  about: string;
  example: string;
}

/** Every project command: what it does and how to use it. The table `activeledger project` prints, and the source of `project help <command>`. */
export const COMMANDS: { [name: string]: CommandHelp } = {
  init: {
    usage: "init [--name <namespace>] [--net <name>=<url>[,<url>...]] [--fix-ignore]",
    about: "Create .activeledger (commit it) and .activeledger-key (never commit it), and make sure the key file is git-ignored.",
    example: "activeledger project init --name myorg --net testnet=http://127.0.0.1:5260",
  },
  identity: {
    usage: "identity new <name> | import <name> <keyfile> | list",
    about: "Make a key pair (or bring one) and onboard it on the network. `list` shows names and stream ids, never keys.",
    example: "activeledger project identity new alice",
  },
  namespace: {
    usage: "namespace register [<namespace>]",
    about: "Register the project's namespace for your identity. Already yours: nothing to do. Taken: the node's refusal is shown.",
    example: "activeledger project namespace register",
  },
  contract: {
    usage: "contract upload <name>|--all | update <name>|--all | status [<name>]",
    about: "Send contract source to the network, update it, or compare the project with what is deployed. The source is audited first.",
    example: "activeledger project contract upload notebook",
  },
  tx: {
    usage: "tx run <name>|--all [--set key=value]... | list",
    about: "Run the example transactions saved in the project and check each reply against what you said to expect.",
    example: "activeledger project tx run add-note",
  },
  deploy: {
    usage: "deploy [--all|<name>...]",
    about: "Register the namespace if needed, then upload or update every contract that is missing or out of date. Safe to repeat, made for CI.",
    example: "activeledger project deploy --net testnet",
  },
  status: {
    usage: "status",
    about: "The project's view of a network: which nodes answer, who owns the namespace, and each contract's state.",
    example: "activeledger project status --net testnet",
  },
};

export const COMMON_FLAGS: [string, string][] = [
  ["--project <name|path>", "Which project file (`staging` means staging.activeledger). Also ACTIVELEDGER_PROJECT."],
  ["--net <name>", "Which network in the file (default: defaultNetwork)."],
  ["--dry-run", "Build and sign, print the transaction, send nothing."],
  ["--json", "Machine-readable output, no banner."],
  ["--yes", "Do not ask before sending (a protected network still needs ACTIVELEDGER_CONFIRM=<network>)."],
];

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

/** What `activeledger project` prints on its own */
export const overview = (withBanner: boolean): string[] => {
  const out: string[] = [];
  if (withBanner) out.push(...banner());
  out.push("Usage: activeledger project <command> [options]", "", "Commands");
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
  for (const [name, c] of Object.entries(COMMANDS)) out.push(`  ${pad(name, width)}${c.about}`);
  out.push("", "Options for every command");
  const fw = Math.max(...COMMON_FLAGS.map(([f]) => f.length)) + 2;
  for (const [f, d] of COMMON_FLAGS) out.push(`  ${pad(f, fw)}${d}`);
  out.push("", "Start here", "  activeledger project init --name myorg --net testnet=http://127.0.0.1:5260", "  activeledger project identity new alice", "  activeledger project deploy", "", "More: activeledger project help <command>");
  return out;
};

/** `project help <command>`, or undefined for a name that is not a command */
export const commandHelp = (name: string): string[] | undefined => {
  const c = COMMANDS[name];
  if (!c) return undefined;
  return [`activeledger project ${c.usage}`, "", c.about, "", "Example", `  ${c.example}`];
};
