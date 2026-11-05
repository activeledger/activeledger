import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { releaseHoldMs, releaseTailMs } from "../packages/network/src/network/releasetimes";

describe("release timings (how long a finished transaction is kept)", () => {
  // Through set(), not a held reference: other test files replace the config object
  const hold = (value: unknown) => ActiveOptions.set("releaseHoldSeconds", value);
  const tail = (value: unknown) => ActiveOptions.set("releaseTailSeconds", value);
  afterEach(() => {
    hold(undefined);
    tail(undefined);
  });

  it("keeps today's values when nothing is configured: 1 minute whole, then 2 minutes", () => {
    hold(undefined);
    tail(undefined);
    expect(releaseHoldMs()).to.equal(60_000);
    expect(releaseTailMs()).to.equal(120_000);
  });

  it("uses the configured seconds, and 0 is allowed", () => {
    hold(30);
    tail(0);
    expect(releaseHoldMs()).to.equal(30_000);
    expect(releaseTailMs()).to.equal(0);
  });

  it("reads a value given as text, as a command line flag would be", () => {
    hold("45");
    expect(releaseHoldMs()).to.equal(45_000);
  });

  it("falls back to the default for anything that is not a number of zero or more", () => {
    for (const bad of [-5, NaN, "soon", Infinity, {}]) {
      hold(bad);
      tail(bad);
      expect(releaseHoldMs(), String(bad)).to.equal(60_000);
      expect(releaseTailMs(), String(bad)).to.equal(120_000);
    }
  });

  it("reads each key independently", () => {
    hold(undefined);
    tail(10);
    expect(releaseHoldMs()).to.equal(60_000);
    expect(releaseTailMs()).to.equal(10_000);
  });
});
