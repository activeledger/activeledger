import { expect } from "chai";
import "mocha";
import {
  isAuthorityExpired,
  hasNonExpiringAuthority,
} from "../packages/definitions/src/definitions/ledger";

// One definition of "expired", shared by the contracts layer, the
// permissions checker and the stream updater. It takes the time to
// compare against as an argument rather than reading a clock, because
// the only safe value is the transaction's own $datetime - every node
// sees the same one, so every node reaches the same verdict.
describe("Authority expiry predicate (Activedefinitions)", () => {
  const at = "2026-06-01T12:00:00.000Z";
  const key = (expire?: string) =>
    ({ public: "p", type: "rsa", stake: 100, expire } as any);

  it("treats an authority with no expire as never expiring", () => {
    expect(isAuthorityExpired(key(undefined), at)).to.equal(false);
    expect(isAuthorityExpired(key(undefined), "2999-01-01T00:00:00.000Z")).to.equal(false);
  });

  it("treats a past expire as expired", () => {
    expect(isAuthorityExpired(key("2026-05-31T23:59:59.999Z"), at)).to.equal(true);
  });

  it("treats a future expire as live", () => {
    expect(isAuthorityExpired(key("2026-06-01T12:00:00.001Z"), at)).to.equal(false);
  });

  // The boundary is inclusive: expire == $datetime is expired. Stated
  // once here so both signature paths can rely on it.
  it("treats expire exactly equal to the compare time as expired", () => {
    expect(isAuthorityExpired(key(at), at)).to.equal(true);
  });

  it("does not read a clock - same inputs, same answer", () => {
    const a = key("2026-05-01T00:00:00.000Z");
    expect(isAuthorityExpired(a, at)).to.equal(isAuthorityExpired(a, at));
  });

  describe("hasNonExpiringAuthority", () => {
    it("is true when any authority has no expire", () => {
      expect(hasNonExpiringAuthority([key("2026-01-01T00:00:00.000Z"), key(undefined)])).to.equal(true);
    });

    it("is false when every authority carries an expire", () => {
      expect(
        hasNonExpiringAuthority([key("2999-01-01T00:00:00.000Z"), key("2030-01-01T00:00:00.000Z")])
      ).to.equal(false);
    });

    // A far-future expire is still an expire. The invariant is about the
    // field being absent, not about the date being distant - otherwise
    // the stream becomes unusable the day it passes.
    it("is false even for an expire centuries away", () => {
      expect(hasNonExpiringAuthority([key("2999-01-01T00:00:00.000Z")])).to.equal(false);
    });

    // Plenty of streams carry no authorities at all - a contract's own
    // data streams, anything created without setAuthority. The rule is
    // "if you have keys, one must be permanent", not "you must have a
    // key", so these are vacuously fine.
    it("is true for a stream with no authorities", () => {
      expect(hasNonExpiringAuthority(undefined)).to.equal(true);
      expect(hasNonExpiringAuthority([])).to.equal(true);
    });
  });
});
