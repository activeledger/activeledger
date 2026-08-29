import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "../packages/options/lib";
import { expect } from "chai";
import "mocha";

// Regression coverage for the hpe-14 perf fix (aa365df) that hoisted
// securityScan()'s ~80-entry read-only denylists to module scope instead
// of rebuilding them on every call. Calling securityScan() directly on the
// prototype with a bare `{}` as `this` (matching how this was verified
// live during hpe-14 - the method doesn't touch any instance state, only
// its own arguments and the module-level denylists) sidesteps needing a
// full Contract/VM instantiation.

function scan(source: string, namespace = "somenamespace"): string | null {
  try {
    Contract.prototype.securityScan.call({}, source, namespace);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

describe("Contract.securityScan() - hpe-14 regression (aa365df)", () => {
  it("allows a clean contract with no violations", () => {
    expect(scan("export default class Foo { vote() { return 1; } }")).to.be.null;
  });

  it("blocks a banned global identifier (process)", () => {
    const result = scan("export default class Foo { vote() { return process.env; } }");
    expect(result).to.not.be.null;
    expect(result).to.include("process");
  });

  it("blocks a require() of a module not on the allow-list", () => {
    const result = scan('const x = require("fs");');
    expect(result).to.not.be.null;
    expect(result).to.include("fs");
  });

  it("blocks a banned property access (constructor)", () => {
    const result = scan("export default class Foo { vote() { return ({}).constructor; } }");
    expect(result).to.not.be.null;
    expect(result).to.include("constructor");
  });

  it("blocks a banned property access (exit)", () => {
    const result = scan("export default class Foo { vote() { return process.exit; } }");
    expect(result).to.not.be.null;
  });

  it("still allows a protected identifier to be used (just not reassigned/shadowed)", () => {
    expect(scan("export default class Foo { vote() { return new Date(); } }")).to.be.null;
  });

  it("skips the scan entirely for the privileged 'default' namespace", () => {
    // Would otherwise be blocked - proves the privileged-namespace early
    // return still runs before the (now module-scope) denylists are ever
    // consulted.
    expect(scan("process.exit();", "default")).to.be.null;
  });
});

describe("Contract.securityScan() - allowLocalLibs policy flag", () => {
  afterEach(() => {
    // ActiveOptions is a process-wide static singleton - reset it so this
    // suite's config doesn't leak into any other test file's scan() calls.
    ActiveOptions.set("security", undefined);
  });

  const withPolicy = (namespace: string, policy: any) =>
    ActiveOptions.set("security", { namespace: { [namespace]: { policy } } });

  it("blocks a same-namespace sibling require() by default (flag off)", () => {
    const result = scan('const lib = require("./mylib@1.0.0");', "libtest");
    expect(result).to.not.be.null;
    expect(result).to.include("not on the allow-list");
  });

  it("allows a same-namespace sibling require() once allowLocalLibs is set for that namespace", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    expect(scan('const lib = require("./mylib@1.0.0");', "libtest")).to.be.null;
  });

  it("allows a same-namespace sibling import once allowLocalLibs is set for that namespace", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    expect(
      scan('import { helper } from "./mylib@1.0.0"; export default class Foo { vote() { return helper; } }', "libtest")
    ).to.be.null;
  });

  it("still blocks a single-level '../' traversal even with allowLocalLibs on", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    const result = scan('const lib = require("../othernamespace/mylib@1.0.0");', "libtest");
    expect(result).to.not.be.null;
    expect(result).to.include("not on the allow-list");
  });

  it("still blocks a nested '../../' traversal even with allowLocalLibs on", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    const result = scan('const lib = require("./a/../../escape");', "libtest");
    expect(result).to.not.be.null;
    expect(result).to.include("not on the allow-list");
  });

  it("does not loosen the allow-list for bare (non-relative) module names", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    const result = scan('const fs = require("fs");', "libtest");
    expect(result).to.not.be.null;
    expect(result).to.include("fs");
  });

  it("is scoped per-namespace - a different namespace without the flag is unaffected", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    const result = scan('const lib = require("./mylib@1.0.0");', "someothernamespace");
    expect(result).to.not.be.null;
    expect(result).to.include("not on the allow-list");
  });

  it("still respects allowLocalLibs for TypeScript's 'import x = require(...)' form", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    expect(scan('import lib = require("./mylib@1.0.0"); export default class Foo { vote() { return 1; } }', "libtest")).to.be.null;
  });

  it("still blocks a traversal attempt via 'import x = require(...)' even with the flag on", () => {
    withPolicy("libtest", { allowLocalLibs: true });
    const result = scan('import lib = require("../escape"); export default class Foo { vote() { return 1; } }', "libtest");
    expect(result).to.not.be.null;
    expect(result).to.include("not on the allow-list");
  });
});

// A live-confirmed bypass found while verifying allowLocalLibs: a contract
// using `import x = require("fs")` (TypeScript's legacy import-equals form,
// a distinct AST node from both `require(...)` calls and `import ... from`)
// passed securityScan() completely undetected, and could then call
// x.readFileSync() to read real files at runtime - readFileSync (and every
// other *Sync fs method) was also missing from BANNED_PROPERTIES entirely.
// Deployed and ran for real against a live node before this fix: it read
// and returned the actual host's /etc/hostname content via ledger state.
describe("Contract.securityScan() - import-equals / export-from module bypass", () => {
  it("blocks 'import x = require(\"fs\")' - previously a silent, complete bypass", () => {
    const result = scan('import sneaky = require("fs"); export default class Foo { vote() { return 1; } }');
    expect(result).to.not.be.null;
    expect(result).to.include("fs");
    expect(result).to.include("not on the allow-list");
  });

  it("still allows 'import x = require(...)' for a module that's actually on the allow-list", () => {
    expect(
      scan('import toolkit = require("@activeledger/activetoolkits"); export default class Foo { vote() { return 1; } }')
    ).to.be.null;
  });

  it("blocks 'export * from \"fs\"' re-exports", () => {
    const result = scan('export * from "fs";');
    expect(result).to.not.be.null;
    expect(result).to.include("fs");
  });

  it("blocks 'export { readFileSync } from \"fs\"' named re-exports", () => {
    const result = scan('export { readFileSync } from "fs";');
    expect(result).to.not.be.null;
    expect(result).to.include("fs");
  });

  it("still allows a plain 'export ... from' on an allow-listed module", () => {
    expect(scan('export * from "@activeledger/activetoolkits";')).to.be.null;
  });

  it("blocks readFileSync as a defense-in-depth property check, independent of module gating", () => {
    // Simulates a hypothetical future path where something allow-listed
    // still exposes a real fs-like object - readFileSync itself must stay
    // blocked as a property access on its own, not just via module gating.
    const result = scan(
      'const toolkit = require("@activeledger/activetoolkits"); export default class Foo { vote() { return toolkit.readFileSync("x"); } }'
    );
    expect(result).to.not.be.null;
    expect(result).to.include("readFileSync");
  });

  it("blocks writeFileSync as a defense-in-depth property check", () => {
    const result = scan(
      'const toolkit = require("@activeledger/activetoolkits"); export default class Foo { vote() { return toolkit.writeFileSync("x", "y"); } }'
    );
    expect(result).to.not.be.null;
    expect(result).to.include("writeFileSync");
  });
});
