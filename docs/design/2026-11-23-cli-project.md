# `activeledger` project commands: spec (draft, for review)

## Why

Getting a contract running today means hand-building and signing four kinds of transaction (onboard an identity, register a namespace, deploy a contract, call it) and keeping the stream ids and keys in your head or a scratch file. The old IDE did this for you and is abandoned. This adds the basics to the CLI, driven by files you can commit, so a project can be set up, deployed and exercised from a terminal or CI, the same way each time.

## What it does

- Keeps a project's public state in a committed file, `.activeledger`, and its secrets in an uncommitted one, `.activeledger-key`.
- `init`, `identity`, `namespace`, `contract`, `tx` and `deploy` commands that build, sign and send the transactions in [Deploy, update, lock and unlock](../guide/contracts/deploy.md) and [Keys, identities and namespaces](../guide/identities.md), and record what came back.
- Example transactions saved in the project and run on demand, with the result checked against what you said to expect.
- Runs [`audit`](2026-11-23-audit-command.md) on contract source before it uploads.

It does not run a node, replace the SDKs, or hold funds. Anything it sends is an ordinary signed transaction.

## The files

### `.activeledger` (commit it)

JSON, no secrets, safe to review in a pull request.

```json
{
  "version": 1,
  "namespace": "myorg",
  "defaultNetwork": "testnet",
  "networks": {
    "testnet": {
      "nodes": ["http://127.0.0.1:5260", "http://127.0.0.1:5261"],
      "identity": "alice",
      "protected": false,
      "contracts": {
        "notebook": { "id": "<contract stream id>", "version": "0.0.2", "hash": "<sha256 of the source last sent>" }
      }
    },
    "production": { "nodes": ["https://node1.example.com:5260"], "identity": "alice", "protected": true }
  },
  "contracts": {
    "notebook": { "source": "src/notebook.ts", "version": "0.0.2" }
  },
  "transactions": {
    "add-note": {
      "contract": "notebook",
      "entry": "create",
      "input": { "@alice": { "note": "hello" } },
      "output": { "nb": {} },
      "expect": { "commit": "all" }
    }
  }
}
```

- `contracts` is what the project has (source path and the version you are working on). `networks.<n>.contracts` is what that network has (stream id, deployed version, hash of the source sent). The ids differ per network, so they live under the network.
- `@alice` in an example transaction means "that identity's stream id on the chosen network"; `@namespace` and `@contract:<name>` work the same way. Nothing else is substituted.
- The CLI writes only the `networks.<n>.contracts` entries it learns from a successful transaction. It never rewrites your own edits to the rest, and it writes through a temp file and a rename.

### `.activeledger-key` (never commit it)

```json
{
  "version": 1,
  "identities": {
    "alice": {
      "type": "rsa",
      "private": "-----BEGIN PRIVATE KEY-----...",
      "public": "-----BEGIN PUBLIC KEY-----...",
      "streams": { "testnet": "<stream id>", "production": "<stream id>" }
    }
  }
}
```

Mode 0600. Never printed, never put in output, `--json` or error text.

### The ignore check

Before any command reads or writes a key file the CLI runs these checks, and stops with a message if one fails:

1. If the folder is in a git repository, `git check-ignore -q <key file>` must say it is ignored. If not: refuse, and say `activeledger init --fix-ignore` (or the command to run) will append it to `.gitignore`.
2. `git ls-files --error-unmatch <key file>` must fail (the file is not tracked). Ignoring a file that is already tracked does nothing, so a tracked key file is refused, with the `git rm --cached` command to run.
3. The file mode must not be readable by group or other; the CLI fixes it to 0600 on creation and refuses a looser one.
4. Outside a git repository it warns once and carries on.

`--allow-unignored-key` exists for CI containers and prints a warning each time. There is no way to make the CLI print a key.

### More than one project file

A folder can hold several, for example one per environment or per team:

```
.activeledger                 .activeledger-key
staging.activeledger          staging.activeledger-key
```

The key file is always the project file's name plus `-key`. Choosing one:

1. `--project <name|path>` (`--project staging` means `staging.activeledger`).
2. `ACTIVELEDGER_PROJECT` in the environment.
3. Otherwise the only project file in the folder or the nearest parent folder. If there are several and none is named, the command fails and lists them.

`--network <name>` picks a network in the file (default `defaultNetwork`).

## Commands

```
activeledger init [--name <ns>] [--network <name>=<url>[,<url>...]] [--fix-ignore]
activeledger identity new <name> | import <name> <keyfile> | list
activeledger namespace register [<ns>]
activeledger contract upload <name>|--all
activeledger contract update <name>|--all
activeledger contract status [<name>]
activeledger tx run <name>|--all [--set key=value]...
activeledger tx list
activeledger deploy [--all|<name>...]
activeledger status
```

Common flags: `--project`, `--network`, `--dry-run` (build and sign, print the transaction, send nothing), `--json`, `--yes`.

| Command | What it does |
|---|---|
| `init` | Creates `.activeledger` and `.activeledger-key`, adds the key file to `.gitignore`, and checks the ignore. Never overwrites an existing file. |
| `identity new` | Generates a key pair into the key file and onboards it on the network (a self-signed `onboard` transaction), recording the stream id. `import` reads an existing key. `list` prints names, types and stream ids, never keys. |
| `namespace register` | Sends the `namespace` contract transaction. If this identity already owns it, says so and exits 0. If it is taken by another identity, the node's refusal is printed and the exit is 1. |
| `contract upload` | Audits the source, sends the base64 source with the namespace, name and version, and records the stream id, version and source hash under the network. Refuses a name that already has an id on this network (use `update`). |
| `contract update` | Same transaction with `$entry: "update"`. If the source hash equals the recorded one it does nothing. If the version is unchanged but the source differs it asks you to bump `version` in the file. |
| `contract status` | Compares the project to the network: not deployed, deployed and current, deployed and out of date (source or version differs), or on the network but not in the project. Read only. |
| `tx run` | Builds the named transaction, signs it with the identity, sends it, and checks the reply against `expect`. `--set` overrides a value in the example. `--all` runs them in file order and stops at the first failure. |
| `deploy` | The CI one: registers the namespace if needed, then uploads or updates each contract that is missing or out of date. Safe to run repeatedly. |
| `status` | The network's nodes that answer, the namespace owner, and each contract's state. |

### `expect`

`{ "commit": "all" }` (the default for a run) means every node reported commit. `{ "commit": 2 }` means at least that many. `{ "error": "Namespace" }` means the run must fail with an error containing the text, so a refusal can be an example. Anything else in `expect` is compared to the reply's `$streams` and `$summary` and printed as a diff when it differs.

### Output and exit codes

A one-line result per step (`ok`, `skipped (already current)`, `failed: <reason from $summary.errors>`), a summary at the end, or the whole thing as JSON. Exit 0 when every step succeeded or was skipped as already done, 1 when a transaction was refused or an expectation failed, 2 for a bad command, a missing file, a failed ignore check or an unreachable network.

## Safety

- **Protected networks** (`"protected": true`) ask for a typed confirmation before any send, and `--yes` is not enough: CI sets `ACTIVELEDGER_CONFIRM=<network>` to say it means it.
- **Nodes** must be `https` unless the host is loopback or the network sets `"insecure": true`.
- **Audit gate:** `upload`, `update` and `deploy` run [`activeledger audit`](2026-11-23-audit-command.md) on the source and stop on a high or critical finding. `--no-audit` skips it, `--audit-fail-on <severity>` changes the bar. The node's own deploy scan still decides.
- **What is sent** is only what the example or contract says. No telemetry, no extra requests.
- **Keys** are read once per command, held in memory only for the signing, and are never written anywhere but the key file.

## Design notes

- **Transactions come from the existing docs**, so the command is a thin builder: the same JSON, the same signing as `ActiveCrypto`, the same reply parsing as the SDKs. The first step of the build is a table of each transaction's shape checked against a live testnet, so a doc and the CLI cannot drift.
- **Several nodes:** a send goes to the first node that answers and moves to the next on a connection failure, never on a refusal (a refusal is an answer). A transaction that timed out is not resent without its umid being checked first, so a retry cannot run twice.
- **Updates are by stream id**, so `contract update` needs the id from the file; if it is missing, `contract status` can recover it by asking the network for the namespace's contracts (read only).
- **Everything is a pure function of the files and one network** so `--dry-run` prints exactly what a real run would send.
- **`--help`** gets a group for each command and the common flags; `activeledger help <command>` has examples. The command table in `docs/guide/cli/activeledger.md` and a new guide page, "Project files and deploying from the CLI", are part of the work.

## Plan

1. File format, project discovery, the ignore check, `init`, `identity`, `status`, with unit tests (git behaviour via a temp repository).
2. `namespace register`, `contract upload|update|status`, `deploy`, against a fake node in unit tests and the 4-node testnet harness live.
3. `tx run|list` with `expect`, `--set` and `@` references.
4. Protected networks, audit gate, `--help`, guide page, README.

## Open questions

- **Names:** `deploy` as the CI verb is clear, but `identity`, `namespace`, `contract` and `tx` need checking against the existing command list (`init` in particular) so nothing collides.
- **Key at rest:** plain with mode 0600 (this spec), or optionally passphrase-encrypted? Encrypting is a clean follow-up; it changes how CI supplies the key.
- **One identity per network, or several?** The spec allows several in the key file but the project names one per network. Is that enough?
- **Lock and unlock** contract versions are left out of the first cut. Add as `contract lock|unlock`?
