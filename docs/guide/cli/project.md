# Project commands: set up and deploy from the terminal

`activeledger project` does the setup work for you: it makes an identity, registers a namespace, uploads and updates contracts, and runs example transactions, all from files you can commit. Everything it sends is an ordinary signed transaction, the same ones described in [Keys, identities and namespaces](../identities.md) and [Deploy, update, lock and unlock](../contracts/deploy.md).

Run it on its own to see every command and how to use it:

```
activeledger project
```

```
        /\
       /  \
      / /\ \
     / /  \ \
    / /____\ \
   /_/      \_\

 ###   #### ##### ### #   # ##### #     ##### ####   #### ##### #### 
 ...

Usage: activeledger project <command> [options]

Commands
  init       Create .activeledger (commit it) and .activeledger-key (never commit it), ...
  identity   Make a key pair (or bring one) and onboard it on the network. ...
  namespace  Register the project's namespace for your identity. ...
  contract   Send contract source to the network, update it, or compare ...
  tx         Run the example transactions saved in the project ...
  deploy     Register the namespace if needed, then upload or update every contract ...
  status     The project's view of a network ...
```

The banner is drawn only for a person at a terminal. It is left out with `--json`, `--quiet`, in CI (`CI` is set) and with `NO_BANNER`. `activeledger project help <command>` shows one command with an example.

## Five minutes to a deployed contract

```
activeledger project init --name myorg --net testnet=http://127.0.0.1:5260
activeledger project identity new alice
# add your contract to .activeledger (see below), then:
activeledger project deploy
activeledger project tx run add-note
```

## The two files

**`.activeledger`** is the project. It holds no secrets, and you commit it.

```json
{
  "version": 1,
  "namespace": "myorg",
  "defaultNetwork": "testnet",
  "networks": {
    "testnet": { "nodes": ["http://127.0.0.1:5260", "http://127.0.0.1:5261"] },
    "production": { "nodes": ["https://node1.example.com:5260"], "protected": true }
  },
  "contracts": {
    "notebook": { "source": "src/notebook.ts", "version": "0.0.1" }
  },
  "transactions": {
    "add-note": {
      "contract": "notebook",
      "entry": "create",
      "input": { "@alice": { "note": "hello" } },
      "output": {},
      "expect": { "commit": 1 }
    }
  }
}
```

- `contracts` is what the project has: the source file and the version you are working on. The CLI also writes what each network has (the contract's stream id, the version and a hash of the source last sent) under `networks.<name>.contracts`, so a second `deploy` knows there is nothing to do.
- Nodes must be `https`, except `http` to this machine. Set `"insecure": true` on a network to allow plain `http` elsewhere.
- `"protected": true` asks for a typed confirmation before anything is sent to that network. `--yes` does not skip it; in CI set `ACTIVELEDGER_CONFIRM=<network name>`.
- In an example transaction, `@alice` means that identity's stream id on the chosen network, `@namespace` the project's namespace and `@contract:notebook` a deployed contract's stream id. `@alice` works as a key too. Nothing else is substituted.
- `expect`: `{ "commit": 1 }` (the default) means at least one node committed and nothing errored. `{ "commit": 3 }` wants three, `{ "commit": "all" }` every node. `{ "error": "Namespace Reserved" }` means the run must fail with an error containing that text, so a refusal can be an example.

Treat `.activeledger` like a script: it chooses which nodes your signed transactions go to and which files are uploaded. Read one you did not write before you run it. Contract sources must be `.ts` or `.js` files inside the project's folder, and never the key file.

**`.activeledger-key`** holds the identities: the type, the private and public key, and the identity's stream id on each network. It is created with mode 600 and never printed.

**Never commit it.** The CLI makes sure it does not get committed:

- `init` adds it to `.gitignore`.
- Before any command reads it, the CLI checks that git ignores it and has not tracked it. If it is not ignored you are told to run `activeledger project init --fix-ignore`. If it is already tracked it is refused, with the `git rm --cached` command to run (and a reminder that the keys in it are exposed and should be rotated).
- A key file that other users can read, or that is a symbolic link, or is owned by someone else, is refused.
- Outside a git repository the CLI warns once and carries on. `--allow-unignored-key` skips the check for CI containers and warns every time.

### More than one project

A folder can hold several project files, for example one per environment:

```
.activeledger            .activeledger-key
staging.activeledger     staging.activeledger-key
```

Each has its own key file, named after it with `-key` on the end. Choose with `--project staging` (or `ACTIVELEDGER_PROJECT=staging`). With more than one in a folder and none chosen, the command stops and lists them. Looking upward from a folder stops at the git repository's root, and a file found that way must be a real file you own.

## Commands

| Command | What it does |
|---|---|
| `init [--name <ns>] [--net <name>=<url>[,<url>...]] [--fix-ignore]` | Creates both files and the `.gitignore` line. Never overwrites an existing project file. |
| `identity new <name> [--type rsa]` | Makes a key pair, saves it, and onboards it on the network. If onboarding fails the key is kept; `identity onboard <name>` retries it. |
| `identity import <name> <private file> <public file> [--type <t>]` | Brings an existing key pair and onboards it. |
| `identity onboard <name>` | Onboards a saved identity on the chosen network (for a second network, or a retry). |
| `identity list` | Names, key types and stream ids. Never keys. |
| `namespace register [<ns>]` | Registers the namespace. A second call for the same project does nothing. A name that is taken is refused (`Namespace Reserved`). |
| `contract upload <name>\\|--all` | Audits the source, sends it, and records the stream id, version and hash. |
| `contract update <name>\\|--all` | Sends a new version. Does nothing if the source has not changed. If the source changed but `version` did not, it asks you to bump `version`. |
| `contract status [<name>]` | Not deployed, current, or out of date. Reads files only; sends nothing and needs no key. |
| `tx run <name>\\|--all [--set key=value]...` | Signs and sends an example and checks the reply against `expect`. `--set input.@alice.note=hi` changes a value for one run. `--all` stops at the first failure. |
| `tx list` | The saved examples. |
| `deploy [--all\\|<name>...]` | Registers the namespace if needed, then uploads or updates what is missing or out of date. Safe to run again, so it suits CI. |
| `status` | Which nodes answer, whether the project registered its namespace, and each contract's state. |

Options for every command: `--project`, `--net <name>` (default `defaultNetwork`), `--dry-run` (build and sign, print the transaction, send and write nothing), `--json`, `--yes`.

A send goes to the first node that answers. It moves on to the next node only when a node cannot be reached; a refusal is an answer and is shown as one.

## The audit before an upload

`contract upload`, `contract update` and `deploy` run [`activeledger audit`](../contracts/audit.md) on the source first and stop on a high or critical finding. `--no-audit` skips it, `--audit-fail-on <severity>` changes the bar (`critical`, `high`, `medium` or `low`) and `--offline` skips the dependency lookup. The node's own deploy scan still decides whether the contract is accepted.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every step succeeded or was already done. |
| 1 | A node refused a transaction, or a reply did not meet `expect`. |
| 2 | A bad command, a missing or invalid file, a failed key-file check, or no node could be reached. |

## In CI

```
ACTIVELEDGER_CONFIRM=production activeledger project deploy --net production --json
```

The key file is not in the repository, so CI writes it from a secret before the run. Put the file's contents in a secret and write it to `.activeledger-key` with mode 600 (or use `--allow-unignored-key` in a container that is not a git checkout).
