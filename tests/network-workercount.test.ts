import { expect } from "chai";
import "mocha";
import { workerCount } from "../packages/network/src/network/workercount";

describe("workerCount (the cpus setting)", () => {
  it("takes a plain number as it is, given as a number or as text", () => {
    expect(workerCount(6, 12)).to.equal(6);
    expect(workerCount("6", 12)).to.equal(6);
    expect(workerCount(" 3 ", 12)).to.equal(3);
    expect(workerCount(24, 12)).to.equal(24);
  });

  it("takes a percentage of the physical cores", () => {
    expect(workerCount("50%", 12)).to.equal(6);
    expect(workerCount("25%", 12)).to.equal(3);
    expect(workerCount("100%", 12)).to.equal(12);
    expect(workerCount("200%", 12)).to.equal(24);
    expect(workerCount(" 50 % ", 12)).to.equal(6);
  });

  it("rounds a percentage to the nearest whole worker", () => {
    expect(workerCount("50%", 5)).to.equal(3); // 2.5
    expect(workerCount("40%", 6)).to.equal(2); // 2.4
    expect(workerCount("45%", 6)).to.equal(3); // 2.7
    expect(workerCount("33.3%", 12)).to.equal(4);
  });

  it("never gives fewer than one worker, however small the machine or the share", () => {
    expect(workerCount("50%", 1)).to.equal(1); // 0.5
    expect(workerCount("25%", 1)).to.equal(1); // 0.25
    expect(workerCount("10%", 2)).to.equal(1); // 0.2
    expect(workerCount("1%", 12)).to.equal(1);
    expect(workerCount("50%", 0)).to.equal(1); // cores unknown
    expect(workerCount("50%", NaN)).to.equal(1);
  });

  it("uses the default for anything that is not a positive number", () => {
    for (const bad of [undefined, null, "", 0, "0", "0%", "abc", "-3", -3, "%", "50 percent", "5%%", NaN, {}, "1e3"]) {
      expect(workerCount(bad, 12), String(bad)).to.equal(12);
    }
    expect(workerCount("abc", 12, 4)).to.equal(4);
  });

  it("drops a fraction in a plain number but keeps at least one", () => {
    expect(workerCount("2.9", 12)).to.equal(2);
    expect(workerCount("0.5", 12)).to.equal(12); // under one is not a count
  });
});
