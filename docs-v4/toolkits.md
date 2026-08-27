# `toolkits`

`@activeledger/activetoolkits` (`packages/toolkits/`) is much smaller than its name suggests, and not what an older doc pass might lead you to expect (there is no "extra base classes for contract development" collection here — that description doesn't match the current source and shouldn't be trusted if you see it elsewhere). As of `v4.1.0` it's exactly two things:

```ts
import { PDF, HTTP } from "@activeledger/activetoolkits";
```

- **`PDF`** (`packages/toolkits/src/pdf/`) — a PDF-generation wrapper around [`pdfmake`](http://pdfmake.org/), vendored in directly (`pdf/external/pdfmake.js`) rather than pulled in as an npm dependency.
- **`HTTP`** — just a re-export of `ActiveRequest` from `@activeledger/activeutilities`, under a shorter name.

## Why this is its own package, and why it matters for what a contract can do

Smart contracts run in a locked-down VM sandbox (`packages/activeledger/src/contracts/default/contract.ts`) — no `eval`, no `require`, no direct `process`/`global` access, and critically, **only an explicit allowlist of modules can be imported at all**. By default that allowlist is exactly two entries: `@activeledger/activetoolkits` and `@activeledger/activecontracts`. A network can extend it per-namespace via `security.namespace[<namespace>].std`/`.external` in config (see [configuration.md](configuration.md)), but out of the box, `toolkits` and `contracts` are the *only* things a contract can pull in beyond its own code.

That's the real reason `PDF` lives in its own package rather than, say, being folded into `activecontracts` directly: it needs to be something a contract is actually permitted to `import`, and being pre-allowlisted is what makes that work without every network operator having to explicitly opt a namespace into it.

## Using `PDF`

```ts
import { PDF } from "@activeledger/activetoolkits";

const pdf = new PDF();
await pdf.write(docDefinition); // pdfmake's TDocumentDefinitions shape
const base64 = await pdf.getData();        // base64 string (default encoding)
const dataUri = await pdf.getDataURI();     // data: URI, ready to embed
const buffer = await pdf.getDataBuffer();   // raw Buffer
```

`write()` builds the document from a `pdfmake`-style definition object; the three `getData*` methods pull the finished result out in whatever form is useful — a data URI to embed directly in a response, a base64 string to store on a stream, or a raw `Buffer`. This is the kind of thing a contract would use in its `commit()` or `postProcess()` phase (see [contracts.md](contracts.md)) to generate something like a receipt or certificate as part of a transaction's result, since there's no other way for sandboxed contract code to produce binary output.
