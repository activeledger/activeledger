# `activeledger audit`: design (built in step 1-4 on feat/audit-command, see docs/guide/contracts/audit.md)

## What it is

`activeledger audit <file-or-folder>` reads source files and prints one table per file of findings, then a risk score. It changes nothing and needs no running node. Main users: contract authors before uploading a contract, and the team on this repo.

## Scope

Targets are contract sources only (the files a developer submits). Contract rules apply to every file given; the generic checks (duplicates, hygiene) run only on those files. Walks a folder, skips `node_modules`, `.git`, build output and files over a size limit.

## Checks (each finding has: rule id, severity, line, one-line why, one-line fix)

| Group | Examples |
|---|---|
| Security | `eval`/`new Function`, dynamic `require`/`import`, `process`/`fs`/`child_process` use, network calls to non-allowed hosts (reuses the contract storage-guard and transpile rules), prototype-pollution patterns, hard-coded keys/tokens, weak hashing, `Math.random` for ids, unbounded loops in `vote`/`commit` |
| Contract rules | `verify`/`vote`/`commit` present and returning the right type, writes outside `$o`, reads of undeclared streams, `{ leader: true }` returned without the matching conditions, non-deterministic code in a vote (time, random) |
| Best practice | unhandled promise rejections, swallowed errors, `any` overuse, missing input validation on `this.transactions`, very long functions, deep nesting |
| Duplicate code | token-window duplicate detection across the scanned files (same normalised block of N lines) |
| Hygiene | dead exports, unused imports, TODO/FIXME left, `console.log` in a contract, large files |

## Dependencies

Imports in a contract are listed, resolved to a version (installed, lockfile or declared), and checked against the npm advisory database: `npm audit --json` when a `package.json` or lockfile sits beside the contract, otherwise the registry's bulk advisory endpoint with the name and version list. Each advisory is a finding (package, version, severity, advisory id, fixed version) and counts in the score. A range such as `^1.2.0` or `latest` is a finding itself, since the version that runs is unknown. Needs the registry; only names and versions are sent, never source. `--offline` skips it. To confirm: whether the contract sandbox allows external imports at all; if not, this mostly flags contracts that try.

## Engine

Deterministic: a TypeScript AST walk (the compiler API is already a dependency) plus pattern rules. Same input gives the same output, so it can run in CI and be compared between runs. Rules are small modules in `packages/activeledger/src/audit/rules/`, each exporting `{ id, group, severity, check(ast, file) }`.

Optional later (not in v1): an `--explain` flag that sends findings, never keys or whole files, to a model for fix suggestions. Off by default.

## Output

- Per file: a table with columns `Line | Severity | Rule | Finding | Fix`.
- Summary table: files, findings by severity and by group.
- `--json` for tooling, `--fail-on <severity>` for a non-zero exit in CI, `--rules`/`--skip` to select rules.

## Risk score

0 to 100 per file and overall, higher is worse. Points per finding by severity (critical 25, high 10, medium 4, low 1), capped at 100 per file; overall is the maximum file score blended with the average, so one bad file cannot hide in a big clean folder, and the finding counts by severity are printed beside it. Bands: 0-9 low, 10-39 medium, 40-69 high, 70+ critical. The weights are plain constants in one file so they can be tuned.

## Plan

1. Rule interface, AST runner, folder walk, table output, risk score (one file, three rules).
2. Security and contract-rule groups, reusing the existing storage-guard and transpile checks.
3. Duplicate detection and hygiene.
4. `--json`, `--fail-on`, docs page, tests: one fixture file per rule that must fire and one that must not.

## Decisions

- Overall score is a blend, with counts printed beside it.
- Contracts only.
- Dependency advisories included, on by default, `--offline` to skip.

## Open questions

- Any rules you want from the earlier red-team passes added on day one?
