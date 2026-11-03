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
`npm run stress:throughput`, `stress:cold-start`, `stress:memory` and
`stress:compare` measure throughput, start-up reliability and memory on a real
local network. They never run in `npm test`. Run the quick profile before and
after a change to the peer-to-peer or consensus path, storage or worker
settings, and before a release. See the "Stress tests" page in the guide
(`docs/guide/stress/index.md`) for what each measures and how to read it.
