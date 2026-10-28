# Writing a contract

This page takes you from an empty file to a contract that compiles and would pass the checks a node makes at deployment. It ends with the rules on what a contract can and cannot do.

## What you are building

A notebook. One transaction creates a notebook stream owned by whoever signed it. Later transactions add notes, and only the owner may add them. Anyone can read a notebook back without changing it. It uses the three steps, an `$entry` to tell the two operations apart, a `read` method, and returns data to the caller.

## 1. Set up a folder

A contract is a single TypeScript file. It imports from one package, `@activeledger/activecontracts`, which gives you the base class and the types.

```bash
mkdir notebook && cd notebook
npm init -y
npm install @activeledger/activecontracts typescript
```

If you are working inside a checkout of the Activeledger repository, the package is already there once you have run `npm ci` and `npm run build` (see [Install and build](../install.md)).

## 2. Write the contract

Save this as `notebook.ts`.

```ts
import { Standard, Activity } from "@activeledger/activecontracts";

export default class Notebook extends Standard {
  private owner: string;
  private note: string;
  private notebook: Activity;

  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (selfsigned) {
        reject("Self-signed transactions are not accepted");
      } else {
        resolve(true);
      }
    });
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // The signer: the first (and only) input
      this.owner = Object.keys(this.transactions.$i)[0];
      this.note = this.transactions.$i[this.owner].note as string;
      if (!this.note) {
        reject("A note is needed");
        return;
      }

      switch (this.transactions.$entry) {
        case "create":
          resolve(true);
          break;
        case "add":
          const output = Object.keys(this.transactions.$o || {})[0];
          if (!output) {
            reject("An output stream is needed");
            return;
          }
          this.notebook = this.getActivityStreams(output);
          if (this.notebook.getState().owner !== this.owner) {
            reject("Only the owner can add a note");
            return;
          }
          resolve(true);
          break;
        default:
          reject("Unknown entry");
      }
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      if (this.transactions.$entry === "create") {
        this.notebook = this.newActivityStream("notebook");
      }
      const state = this.notebook.getState();
      const notes = (state.notes as string[]) || [];
      notes.push(this.note);
      state.owner = this.owner;
      state.notes = notes;
      this.notebook.setState(state);

      this.returnToRemote({ notebook: this.notebook.getId(), count: notes.length });
      resolve(true);
    });
  }

  // A read-only call: no $i, the notebook named under $r as "nb"
  public read(): any {
    return { version: "0.0.1", notebook: this.getReadOnlyStream("nb") };
  }
}
```

## 3. What each part does

**The class.** A contract is the `export default` class of its file. It extends `Standard`, which gives it `this.transactions` (the `$tx` part of the transaction), the stream methods and the three steps. The private fields carry what `vote` found through to `commit`.

**`verify(selfsigned)`.** The engine passes `true` when the transaction was self-signed, which is how a brand-new identity is created before it has a stream of its own. A notebook always belongs to an existing identity, so the contract refuses those. Rejecting with a string is how a contract says no; the string is returned to the caller.

**`vote()`.** The contract reads the input. In `$i`, each key is the id of a signed stream and the value is whatever the caller put there, here a `note`. The engine has already checked the signature, so the key is a trustworthy "who". On `add`, the contract fetches the notebook from `$o` with `getActivityStreams` and compares its stored `owner` with the signer. Nothing is changed in `vote`; it only decides.

**`commit()`.** On `create`, `newActivityStream("notebook")` makes a new stream. Its id comes from the transaction's id and the name, so every node produces the same id. `getState()` returns a copy of the stream's data; `setState()` writes the changed copy back. `returnToRemote()` hands an object to the caller, who receives it in the `$responses` list of the reply.

**`read()`.** Runs instead of `vote` and `commit` when a transaction has no `$i` (see [Entry points](index.md#entry-points)). It is an ordinary method: whatever it returns goes back to the caller. `getReadOnlyStream("nb")` is the state of the stream the caller listed under `$r` as `nb`. The `version` string is there so you can tell which version of the contract answered; change it when you deploy a new version.

## 4. Check that it compiles

A node compiles the TypeScript with the compiler bundled in its own packages. You can run the same step yourself from a checkout of the repository. From the repository's root folder (the command needs `./packages/contracts/lib/source.js`):

```bash
node -e '
const { ContractSource } = require("./packages/contracts/lib/source.js");
const src = require("fs").readFileSync(process.argv[1], "utf8");
process.stdout.write(ContractSource.transpile(Buffer.from(src).toString("base64"), "es2025"));
' path/to/notebook.ts
```

You should see JavaScript starting like this:

```
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activecontracts_1 = require("@activeledger/activecontracts");
class Notebook extends activecontracts_1.Standard {
```

That step turns TypeScript into JavaScript but does not report type errors. To catch those, run the compiler on the file with the same strictness a node uses:

```bash
npx tsc --noEmit --skipLibCheck --alwaysStrict --noImplicitAny --strictNullChecks --strictPropertyInitialization false --target es2017 --module commonjs notebook.ts
```

No output means no errors. Inside the repository, add `--ignoreConfig` straight after `tsc`: TypeScript 7 otherwise stops with `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline`.

## 5. Call it

After [deploying the contract](deploy.md), a transaction creates a notebook. The `$tx` part looks like this; [Sending a transaction](../transactions.md) shows how to sign and send it.

```json
{
  "$namespace": "myorg",
  "$contract": "<contract stream id>",
  "$entry": "create",
  "$i": {
    "<your identity stream id>": { "note": "First note" }
  }
}
```

The reply's `$streams.new` lists the new notebook's id, and `$responses` holds `{ "notebook": "<id>", "count": 1 }`. To add a note, send `"$entry": "add"` with the notebook as an output:

```json
{
  "$namespace": "myorg",
  "$contract": "<contract stream id>",
  "$entry": "add",
  "$i": {
    "<your identity stream id>": { "note": "Second note" }
  },
  "$o": {
    "<notebook stream id>": {}
  }
}
```

Signed by anyone else, the reply carries `Vote Failure - "Only the owner can add a note"` in `$summary.errors`.

To read the notebook back, send a transaction with no `$i` and empty `$sigs`. This is the whole message, not only `$tx`, and nothing is signed:

```json
{
  "$tx": {
    "$namespace": "myorg",
    "$contract": "<contract stream id>",
    "$r": { "nb": "<notebook stream id>" }
  },
  "$sigs": {}
}
```

The reply carries what `read()` returned:

```json
{
  "$umid": "…",
  "$summary": { "total": 1, "vote": 0, "commit": 1 },
  "$responses": [
    { "version": "0.0.1", "notebook": { "owner": "<your identity stream id>", "notes": [ "First note", "Second note" ] } }
  ]
}
```

[Running a contract](run.md) covers the reply in full.

## The rules

When a contract is deployed, the node scans the source before compiling it. Anything on this list stops the deployment with a message such as `Security Violation [2:1]: Import of module 'fs' is forbidden` (line and column included). Contracts in the `default` namespace are the node's own and skip the scan.

**Imports.** You may import `@activeledger/activecontracts` and `@activeledger/activetoolkits` (which exports `HTTP` for requests and `PDF`). Nothing else: no Node built-ins such as `fs`, `crypto` or `http`, and no npm packages. A node operator can widen the list for one namespace in `config.json` under `security.namespace.<namespace>.std` and `.external`; see [config.json](../operate/configuration.md). Every form of loading is checked, including `import x = require(...)`, `export ... from`, `require()` with a non-literal argument and `import()`.

**Globals you cannot use.** `process`, `global`, `globalThis`, `eval`, `Function`, `console`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `fetch`, `atob`, `btoa`, `Reflect`, `Proxy`, `Symbol`, `WebAssembly`, `Intl`, `performance`, `WeakRef`, `arguments`, `module`, `exports`, `__dirname` and `__filename`, among others. Use `this.setTimeout(ms)` to ask for more time, and `ActiveLogger` from the contracts package to log.

**Properties you cannot touch** on any object other than `this`: `constructor`, `prototype`, `__proto__`, `bind`, `call`, `apply`, `assign`, `freeze`, `seal`, `defineProperty`, `getPrototypeOf`, `setPrototypeOf`, `hasOwnProperty`, `valueOf`, `toLocaleString`, `stack`, `exit`, `kill`, `exec`, `spawn`, every `fs`-style method such as `readFile` or `writeFileSync`, and more. This means `Object.assign(a, b)` is refused; use a spread (`{ ...a, ...b }`) instead. Destructuring one of these names (`const { constructor } = x`) is refused too.

**Dynamic access.** `obj[key]` with a variable key is allowed only when `obj` is reached from `this`, such as `this.transactions.$i[key]`. On anything else it is refused. Computed property names in object literals (`{ [key]: 1 }`) are refused unless the key is a string or number literal.

**Syntax that is refused.** `with`, `debugger`, decorators, tagged template literals (`` tag`...` ``), `#private` fields and `new.target`. You also cannot reassign or shadow the built-ins `Math`, `Date`, `JSON`, `Object`, `Array`, `Promise`, `Buffer`, `Map`, `Set`, `Error` and similar, or the Activeledger names `Standard`, `Activity`, `ActiveLogger` and `ActiveCrypto`.

**What the engine does for you.** Each step has a time limit, checked every `contractCheckTimeout` milliseconds (default 10000). A contract that needs longer calls `this.setTimeout(ms)` to push its deadline, never beyond `contractMaxTimeout` minutes (default 20). A contract cannot read or write the ledger database directly; it sees the streams named in `$i`, `$o` and `$r` of the transaction, plus any it asks for with `getAnyStreamReadOnly`.

!!! warning
    Commit runs on every node on its own. Writing `Date.now()`, `new Date()` or `Math.random()` into a stream gives each node a different result and the network fails to agree. Keep everything you store a pure function of the transaction and the streams.

## Next

- [The contract API](reference.md) for every method you can call.
- [Deploy, update, lock and unlock](deploy.md) to put the contract on the ledger.
