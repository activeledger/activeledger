import Contract from "../packages/activeledger/src/contracts/default/contract";
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
