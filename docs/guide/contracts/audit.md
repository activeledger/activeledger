# Auditing a contract

`activeledger audit` reads contract source and prints what is wrong with it before you deploy. It changes nothing and needs no running node.

```
activeledger audit <file|folder> [--json] [--offline] [--fail-on <severity>]
                                 [--only <rules>] [--skip <rules>] [--rules]
```

It reads every `.ts`, `.js`, `.mjs` and `.cjs` file under the path, skipping `node_modules`, hidden folders, build output (`lib`, `dist`, `es`, `build`) and `.d.ts` files.

## What you get

One table per file, then the duplicate blocks, then a summary:

```
contracts/transfer.ts
  Line  Severity  Rule             Finding                                   Fix
  14    critical  no-eval          eval() runs text as code                  Remove it. Parse the data instead of running it.
  31    high      local-service    "http://127.0.0.1:8080" is this machine   Remove it.
  58    medium    swallowed-error  an empty catch hides the failure          Reject with the error, or handle it.
  Risk 39/100 (medium)   critical 1  high 1  medium 1  low 0

Summary
  Files 1   Findings 3   Critical 1  High 1  Medium 1  Low 0
  Overall risk 39/100 (medium)   worst file 39, average 39
```

`--json` prints the same data for tooling. `--rules` lists every rule and exits.

## What it checks

| Group | Rules |
|---|---|
| Security | `no-eval`, `forbidden-global` (process, global, timers, console and the rest the deploy scan refuses), `module-use` (require or import of anything but the toolkits, local files, dynamic names), `prototype-access`, `computed-write`, `local-service` (storage and loopback addresses, `volatile` paths and request options that change the connection, the patterns the storage-guard red-team passes found), `hardcoded-secret`, `weak-crypto` |
| Contract | `nondeterministic` (time and randomness inside verify, vote and commit, where each node would answer differently), `contract-shape` (no class extending Standard, Event or PostProcess; a `{ leader: true }` vote), `unbounded-loop` |
| Best practice | `swallowed-error`, `long-function` (over 80 lines, or nested over 5 deep) |
| Duplicate code | `duplicate-code`: blocks of 6 or more meaningful lines that appear twice, in two files or one |
| Hygiene | `todo`, `large-file` |
| Dependencies | every package a contract imports is looked up in the npm advisory database; each advisory is a finding. `unpinned-version` for a range such as `^1.2.0`, `unknown-version` when no version can be found |

The audit is advice. The node's own deploy scan is the check that decides; a clean audit does not promise a deploy will pass, and a finding does not always mean it will fail.

## Dependencies

The version is the installed one (`node_modules/<package>/package.json`, looking up the folders), otherwise the one declared in the nearest `package.json`. Only package names and versions are sent to the npm registry, never source. `--offline` skips the lookup; the run says so in a note. If the registry cannot be reached the run carries on and says that too.

## The risk score

Each finding adds points: critical 25, high 10, medium 4, low 1. A file's score is the total, at most 100. The overall score is 60% of the worst file plus 40% of the average, so one bad file cannot hide among clean ones and a spread of medium files still shows. The counts by severity are printed beside it.

| Score | Band |
|---|---|
| 0-9 | low |
| 10-39 | medium |
| 40-69 | high |
| 70-100 | critical |

## In CI

`--fail-on high` exits 1 when any finding is high or critical. Exit 0 is a pass, 2 is a bad command (no path, a path that does not exist, no source files, an unknown severity).

```
activeledger audit ./contracts --fail-on high
```
