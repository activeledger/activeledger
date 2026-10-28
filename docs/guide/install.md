# Install and build

How to get the three Activeledger programs onto a machine from the source
repository, and how to check they work.

## Requirements

- **Node.js 24.** Every package declares `"node": ">=24.0.0"`, and 24 is the
  version the project builds and tests on.
- **npm 7 or newer.** The repository is an npm workspace, which arrived in npm 7.
  npm ships with Node.js, so a Node 24 install already has a recent enough npm.
- **git**, to get the source.

!!! note
    Activeledger's storage depends on two packages (`classic-level` and
    `msgpackr-extract`) that build a native part during install. npm 11.19 and
    later no longer run install scripts unless you allow them, and earlier
    versions (11.17 already does) print a warning that starts
    `npm warn allow-scripts`, names `msgpackr-extract` and tells you to run
    `npm approve-scripts`. The install still succeeds. `msgpackr-extract` is an
    optional speed-up for `msgpackr`, which works without it on a slower
    JavaScript path. For the fast path, allow the scripts once before you
    install, as the README says:

    ```bash
    npm config set allow-scripts classic-level,msgpackr-extract
    ```

    `npm approve-scripts classic-level msgpackr-extract` does the same for one
    project, by writing to its `package.json`. On an older npm the setting is
    harmless.

## Get the source and build

```bash
git clone https://github.com/activeledger/activeledger.git
cd activeledger
npm run setup
```

`npm run setup` runs `npm install` and then `npm run build`. The build compiles
every package under `packages/` in dependency order, because the packages import
each other by their published `@activeledger/*` names and the later ones cannot
compile until the earlier ones exist.

For later builds, once `node_modules` is in place, `npm run build` on its own is
enough.

## What gets built

Each package compiles its TypeScript into two folders: `lib/` (CommonJS, what the
programs run) and `es/` (ES modules). The three programs you will run are:

| Program | Built file |
| --- | --- |
| `activeledger` | `packages/activeledger/lib/index.js` |
| `activehybrid` | `packages/hybrid/lib/index.js` |
| `activerestore` | `packages/restore/lib/index.js` |

The version a program reports is stamped into it at build time from its
`package.json`. If the version looks old, rebuild.

## Make the commands available everywhere

After building, link the three packages once so you can type `activeledger`,
`activehybrid` and `activerestore` from any folder:

```bash
npm link ./packages/activeledger ./packages/hybrid ./packages/restore
```

The links point at the source folders, so after every `npm run build` the linked
commands run the new code without linking again.

[The local testnet](first-network.md) needs `activeledger` on your PATH, which
this step gives it.

!!! note
    If you manage Node.js with nvm, each Node version has its own global folder.
    Link again after switching versions.

From inside the repository, `npx activeledger` runs the program without linking.

## Check it worked

```bash
activeledger --help
activehybrid --help
activeledger version
```

Each `--help` prints the program's commands and flags and exits with code 0.
`version` prints the version, for example `v5.1.1`.

`activerestore` has no help command. It expects a node's `config.json` in the
folder it is run from and stops with an error when there is none, so do not run
it as a check. To confirm it is linked:

```bash
which activerestore
```

This prints the path of the link, for example
`/home/you/.nvm/versions/node/v24.19.0/bin/activerestore`.

Next: [Run a first node, then a small network](first-network.md).
