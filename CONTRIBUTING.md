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
