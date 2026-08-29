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
});
