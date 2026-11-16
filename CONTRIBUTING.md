# Contributing

## Installation
This is an npm workspace. One install at the root covers every package and
links them to each other:

```shell
npm install
```

There are interdependencies between the packages, and they import each
other by their published `@activeledger/*` names, so you have to build once
to generate the `d.ts` files before type resolution works:
```shell
npm run build
```

## Stress tests
`npm run stress:throughput`, `stress:realistic`, `stress:cold-start`, `stress:memory` and
`stress:compare` measure throughput, start-up reliability and memory on a real
local network. They never run in `npm test`. Run the quick profile before and
after a change to the peer-to-peer or consensus path, storage or worker
settings, and before a release. See the "Stress tests" page in the guide
(`docs/guide/stress/index.md`) for what each measures and how to read it.

## Mutation testing

Coverage says a line ran; mutation testing says whether a test would notice if
it were wrong. `npm run mutate` breaks one source file one small way at a time
(`===` to `!==`, `&&` to `||`, `>` to `>=`, a dropped return value, ...) and runs
the tests against each change:

```
npm run build
npm run mutate -- packages/protocol/src/protocol/streamUpdater.ts
npm run mutate -- packages/network/src/network/host.ts --lines 1700-2150
npm run mutate -- packages/storage/src/selfhost.ts --rebuild storage --tests tests/cov-storage-selfhost-http.test.ts tests/cov-storage-selfhost-process.test.ts
```

Code the tests reach only through a package's built lib (storage's `selfhost.ts` runs as its own process) needs `--rebuild <package>`, which compiles each change into the throwaway tree first; without it every change looks uncaught.

It prints the changes the tests did **not** catch. Each one is either a missing
test (write it, then re-run with `--lines` on just that line) or a change that
makes no difference, such as a log message or a constant that is the same either
way. Record those in `scripts/mutation-equivalents.json` with the reason so they
stop being reported. It runs in a throwaway worktree under the system temp
directory, so your working tree is never left mutated. Results go to
`.mutation/` (ignored). A large file takes minutes to tens of minutes, so it is
run by hand, not in CI. See the header of `scripts/mutate.mjs` for the options.
