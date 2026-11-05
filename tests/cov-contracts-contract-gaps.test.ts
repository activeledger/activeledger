import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import Contract from "../packages/activeledger/src/contracts/default/contract";

const scan = (source: string, namespace = "somenamespace"): string | null => {
  try {
    Contract.prototype.securityScan.call({}, source, namespace);
    return null;
  } catch (e: any) {
    return e.message;
  }
};

describe("Contract.lockHeld from recorded stream state", () => {
  const held = (version: string, state: any, hasOut = true) =>
    (Contract.prototype as any).lockHeld.call(
      { rootDir: "./no-such-root/", namespace: "ns", contract: "c".repeat(64), version },
      hasOut ? { getState: () => state } : undefined
    );

  it("whole-contract lock: held only when locks.all is truthy", () => {
    expect(held("", { locks: { all: true } })).to.equal(true);
    expect(held("", { locks: { all: false, versions: ["1.0.0"] } })).to.equal(false);
    expect(held("", { locks: { versions: ["1.0.0"] } })).to.equal(false);
  });
  it("version lock: held only when that version (without the @) is recorded", () => {
    expect(held("@1.0.0", { locks: { versions: ["1.0.0", "2.0.0"] } })).to.equal(true);
    expect(held("@2.0.0", { locks: { versions: ["1.0.0"] } })).to.equal(false);
    expect(held("@1.0.0", { locks: { all: true } })).to.equal(false);
  });
  it("nothing recorded, or no output stream, is not held", () => {
    expect(held("", {})).to.equal(false);
    expect(held("@1.0.0", {})).to.equal(false);
    expect(held("", undefined, false)).to.equal(false);
  });
});

describe("Contract constructed for real", () => {
  it("starts with an empty version and the ./contracts/ root", () => {
    const c: any = new (Contract as any)(
      new Date(), "addr", "umid",
      { $namespace: "default", $i: {}, $o: {} },
      [], [], {}, {}, {}, 0, new EventEmitter(), "host"
    );
    expect(c.rootDir).to.equal("./contracts/");
    expect(c.version).to.equal("");
  });
});

describe("Contract.securityScan() - remaining shapes", () => {
  it("blocks a banned property destructured through a backtick computed key", () => {
    const r = scan("export default class Foo { vote() { const { [`constructor`]: c } = ({}); return c; } }");
    expect(r).to.be.a("string").and.include("constructor");
  });
  it("still forbids a harmless backtick computed destructuring key (only string literals are resolved)", () => {
    expect(scan("export default class Foo { vote() { const { [`foo`]: c } = ({ foo: 1 }); return c; } }")).to.include(
      "Dynamic computed property names are forbidden"
    );
  });
  it("rejects an import whose specifier is not a literal", () => {
    expect(scan("import x from foo;")).to.include("Dynamic import specifier is forbidden");
  });
  it("rejects a re-export whose specifier is not a literal", () => {
    expect(scan("export { x } from foo;")).to.include("Dynamic re-export specifier is forbidden");
  });
  it("rejects a re-export of a module off the allow-list but names it", () => {
    expect(scan('export { readFile } from "fs";')).to.include("Re-export of module 'fs' is forbidden");
  });
  it("rejects an import of a module off the allow-list but names it", () => {
    expect(scan('import { readFile } from "fs";')).to.include("Import of module 'fs' is forbidden");
  });
  it("blocks this.constructor followed by a dynamic hop", () => {
    expect(scan("export default class Foo { vote() { const k = 'x'; return this.constructor[k]; } }")).to.include(
      "Dynamic element access is forbidden"
    );
  });
});

