# Contributing

## Installation
We use [lerna](https://lernajs.io/) to manage this monorepo.
Make sure you have lerna installed.
If you use a package manager, install lerna with that. Otherwise:

```shell
npm install
```

There are interdependencies between the packages.
In workspace mode, Lerna can manage type imports between development versions of each, but you need to build first, to generate the `d.ts` files:
```shell
npm run setup
```
