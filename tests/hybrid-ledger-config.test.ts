import { expect } from "chai";
import "mocha";
import { HybridConfig } from "../packages/options/src";

// hybrid-config.test.ts goes through the built lib, because the setup contract
// does, and only checks that a bad section gives some string. This one imports
// the source and pins which reason each rule gives: the text is what an
// operator sees when `--assert` refuses their config.
describe("HybridConfig.validate reasons", () => {
  const id = "c".repeat(64);
  const valid = (): any => ({
    admission: "open",
    required: [id, { id }],
    window: { days: 30 },
    minVersion: "5.1.0",
  });
  const without = (key: string) => {
    const v = valid();
    delete v[key];
    return v;
  };

  it("accepts the documented shape and an allowlist", () => {
    expect(HybridConfig.validate(valid())).to.equal(null);
    expect(HybridConfig.validate({ ...valid(), admission: { allowlist: ["k1", "k2"] }, required: [] })).to.equal(null);
    expect(HybridConfig.validate({ ...valid(), admission: { allowlist: [] } })).to.equal(null);
  });

  it("accepts the boolean volatile that 5.1.0 wrote, so an asserted network still validates", () => {
    expect(HybridConfig.validate({ ...valid(), required: [{ id, volatile: true }, { id, volatile: false }] })).to.equal(null);
  });

  it("accepts prerelease and build semver, and refuses what npm would not publish", () => {
    for (const v of ["5.1.0", "0.0.0", "10.20.30", "5.1.0-beta.1", "5.1.0-rc-1+build.7", "5.1.0+meta"]) {
      expect(HybridConfig.validate({ ...valid(), minVersion: v }), v).to.equal(null);
    }
    for (const v of ["v5.1.0", "5.1", "05.1.0", "5.1.0-", "5.1.0.1", "5.1.0-beta..1", " 5.1.0", ""]) {
      expect(HybridConfig.validate({ ...valid(), minVersion: v }), v).to.equal("hybrid.minVersion must be a semver version");
    }
  });

  it("refuses a value that is not an object", () => {
    for (const v of [null, undefined, [], "open", 5, true]) {
      expect(HybridConfig.validate(v), String(v)).to.equal("hybrid must be an object");
    }
  });

  it("refuses an unknown property, so a typo cannot become the network's rule", () => {
    expect(HybridConfig.validate({ ...valid(), minversion: "5.1.0" })).to.equal("hybrid has unknown properties");
  });

  it("refuses a bad admission", () => {
    const reason = 'hybrid.admission must be "open" or {allowlist:[keys]}';
    for (const admission of ["closed", "OPEN", null, 1, [], { allowlist: "k1" }, { allowlist: [""] }, { allowlist: [5] }, { allowlist: [], other: 1 }, {}]) {
      expect(HybridConfig.validate({ ...valid(), admission }), JSON.stringify(admission)).to.equal(reason);
    }
    expect(HybridConfig.validate(without("admission"))).to.equal(reason);
  });

  it("refuses bad required streams", () => {
    expect(HybridConfig.validate({ ...valid(), required: "x" })).to.equal("hybrid.required must be an array");
    expect(HybridConfig.validate(without("required"))).to.equal("hybrid.required must be an array");
    const reason = "hybrid.required entries must be a stream id or {id}";
    for (const entry of ["short", "C".repeat(64), "c".repeat(63), "c".repeat(65), 5, null, {}, { id: 5 }, { id: "short" }, { id, extra: 1 }, { id, volatile: "yes" }]) {
      expect(HybridConfig.validate({ ...valid(), required: [id, entry] }), JSON.stringify(entry)).to.equal(reason);
    }
  });

  it("refuses a bad storage window", () => {
    const reason = "hybrid.window must be {days} with a whole number of days";
    for (const window of [0, -1, 1.5, "30", null, [], {}, { days: "30" }, { days: 0 }, { days: -3 }, { days: 1.5 }, { days: 30, hours: 1 }]) {
      expect(HybridConfig.validate({ ...valid(), window }), JSON.stringify(window)).to.equal(reason);
    }
    expect(HybridConfig.validate(without("window"))).to.equal(reason);
    expect(HybridConfig.validate({ ...valid(), window: { days: 1 } })).to.equal(null);
  });

  it("refuses a missing or non-string minVersion", () => {
    const reason = "hybrid.minVersion must be a semver version";
    expect(HybridConfig.validate(without("minVersion"))).to.equal(reason);
    expect(HybridConfig.validate({ ...valid(), minVersion: 510 })).to.equal(reason);
  });

  it("does not take the legacy hybrid[] URL list for a section, but takes an empty object", () => {
    expect(HybridConfig.isSection([])).to.equal(false);
    expect(HybridConfig.isSection(["http://x"])).to.equal(false);
    expect(HybridConfig.isSection(undefined)).to.equal(false);
    expect(HybridConfig.isSection(null)).to.equal(false);
    expect(HybridConfig.isSection("open")).to.equal(false);
    expect(HybridConfig.isSection({})).to.equal(true);
  });
});
