import { expect } from "chai";
import "mocha";
// Imported by package name, NOT from ../packages/options/src. The
// subject imports "@activeledger/activeoptions", which resolves through
// node_modules to the package's built lib/ - a different module instance
// with its own static config. Setting build on the src copy would leave
// the subject reading 0 and silently pass the "not enforced" case while
// failing both enforced ones.
import { ActiveOptions } from "@activeledger/activeoptions";
import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";

// Expiry is not a schema difference between versions - it changes the
// VOTE. An enforcing node rejects a signature an ignoring node accepts,
// which splits consensus on a timer, from a rollout rather than a fault.
// So nothing takes effect until the operator raises build, once every
// node understands the field.
describe("Expiry rollout gate (Activeprotocol)", () => {
  const PAST = "2020-01-01T00:00:00.000Z";
  const NOW = "2026-06-01T12:00:00.000Z";

  let original: any;
  beforeEach(() => {
    original = ActiveOptions.get("build", 0);
  });
  afterEach(() => {
    ActiveOptions.set("build", original);
  });

  const rejectionAtBuild = (build: number) => {
    ActiveOptions.set("build", build);
    const checker: any = new PermissionsChecker(
      {
        $umid: "u".repeat(64),
        $datetime: NOW,
        $tx: {},
        $sigs: { streamA: "SIGNATURE" },
      } as any,
      {} as any,
      {} as any,
      { signatureCheck: () => true, getLabelIOMap: () => "streamA" } as any
    );
    checker.inputs = true;
    let rejection: any;
    checker.checkSingleSignature(
      "streamA",
      "streamA",
      {
        state: { _id: "streamA" },
        meta: {
          _id: "streamA:stream",
          authorities: [{ public: "p", type: "rsa", stake: 100, hash: "h", expire: PAST }],
        },
      } as any,
      "SIGNATURE",
      false,
      {},
      (r: any) => (rejection = r)
    );
    return rejection;
  };

  it("ignores expiry below the threshold - behaves exactly as today", () => {
    expect(rejectionAtBuild(40000)).to.equal(undefined);
  });

  it("enforces expiry at the threshold", () => {
    expect(rejectionAtBuild(40100).code).to.equal(1235);
  });

  it("enforces expiry above the threshold", () => {
    expect(rejectionAtBuild(50000).code).to.equal(1235);
  });
});
