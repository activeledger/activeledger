import { expect } from "chai";
import "mocha";
import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
// By package name, not ../packages/options/src - the subject resolves
// "@activeledger/activeoptions" through node_modules to the built lib/,
// which is a different module instance with its own static config.
import { ActiveOptions } from "@activeledger/activeoptions";

// An expired key must not authorise anything - and the rejection must
// say WHY. A correct signature from a lapsed key reported as 1220
// "Signature Incorrect" sends the caller hunting a key problem that does
// not exist. 1235 distinguishes "right key, too late" from "wrong key".
describe("Expired authorities cannot sign (Activeprotocol)", () => {
  const PAST = "2020-01-01T00:00:00.000Z";
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const NOW = "2026-06-01T12:00:00.000Z";

  // Expiry is gated behind build >= 40100 so a half-upgraded network
  // cannot split consensus. This suite is about the enforcement itself,
  // so it runs with the gate open; authority-expiry-rollout.test.ts
  // covers the gate.
  let originalBuild: any;
  before(() => {
    originalBuild = ActiveOptions.get("build", 0);
    ActiveOptions.set("build", 40100);
  });
  after(() => {
    ActiveOptions.set("build", originalBuild);
  });

  const entry = (): any => ({
    $umid: "u".repeat(64),
    $datetime: NOW,
    $tx: { $contract: "c", $namespace: "default" },
    $sigs: { streamA: "SIGNATURE" },
  });

  // signatureCheck is the only thing the subject needs from Shared, and
  // stubbing it keeps this about expiry rather than about RSA.
  const shared = (valid: boolean): any => ({
    signatureCheck: () => valid,
    getLabelIOMap: () => "streamA",
  });

  const streamWith = (authorities: any[]): any => ({
    state: { _id: "streamA" },
    meta: { _id: "streamA:stream", authorities },
  });

  const check = (authorities: any[], signatureValid = true) => {
    const checker: any = new PermissionsChecker(
      entry(),
      {} as any,
      {} as any,
      shared(signatureValid)
    );
    checker.inputs = true;
    let rejection: any;
    checker.checkSingleSignature(
      "streamA",
      "streamA",
      streamWith(authorities),
      "SIGNATURE",
      false,
      {},
      (r: any) => (rejection = r)
    );
    return rejection;
  };

  const live = { public: "p1", type: "rsa", stake: 100, hash: "h1" };
  const expired = { public: "p2", type: "rsa", stake: 100, hash: "h2", expire: PAST };
  const notYet = { public: "p3", type: "rsa", stake: 100, hash: "h3", expire: FUTURE };

  it("accepts a signature from a key with no expire", () => {
    expect(check([live])).to.equal(undefined);
  });

  it("accepts a signature from a key whose expire is still ahead", () => {
    expect(check([notYet])).to.equal(undefined);
  });

  it("rejects a signature from an expired key with 1235", () => {
    const rejection = check([expired]);
    expect(rejection).to.not.equal(undefined);
    expect(rejection.code).to.equal(1235);
    expect(rejection.reason).to.contain("Expired");
  });

  // The distinction that makes 1235 worth having.
  it("still returns 1220 for a genuinely wrong signature", () => {
    const rejection = check([live], false);
    expect(rejection.code).to.equal(1220);
  });

  it("accepts when a live key sits alongside an expired one", () => {
    expect(check([expired, live])).to.equal(undefined);
  });

  it("rejects when every authority has expired", () => {
    expect(check([expired, { ...expired, hash: "h4" }]).code).to.equal(1235);
  });
});

// Deliberately unchanged. Excluding expired keys from stake is arguably
// more correct, but it would silently alter the behaviour of every
// existing contract using stake-based consensus the moment a key lapsed,
// including ones nobody revisits. Pinned here so the decision is visible
// rather than assumed.
describe("Expiry does not change stake (Activecontracts)", () => {
  it("hasAuthorityStake still counts an expired authority", () => {
    const { EventEmitter } = require("events");
    const { Activity } = require("../packages/contracts/src/stream");
    const activity = new Activity(
      "umid-seed",
      null,
      true,
      new EventEmitter(),
      { _id: "s:stream", _rev: "1-a" },
      { _id: "s", _rev: "1-a" }
    );
    activity.setAuthorities([
      { public: "p1", type: "rsa", stake: 60 },
      { public: "p2", type: "rsa", stake: 40, expire: "2020-01-01T00:00:00.000Z" },
    ] as any);

    const total = activity
      .getAuthorities()
      .reduce((sum: number, a: any) => sum + a.stake, 0);
    expect(total).to.equal(100);
  });
});
