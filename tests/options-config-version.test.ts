import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "../packages/options/src/options";

describe("ActiveOptions.configVersion", () => {
  it("moves on every set, so a held copy of the config can tell it is stale", () => {
    ActiveOptions.init();
    const before = ActiveOptions.configVersion;
    ActiveOptions.set("configVersionProbe", 1);
    expect(ActiveOptions.configVersion).to.be.greaterThan(before);
    const mid = ActiveOptions.configVersion;
    ActiveOptions.set("configVersionProbe", 2);
    expect(ActiveOptions.configVersion).to.be.greaterThan(mid);
  });

  it("moves when the config file is parsed again", () => {
    const before = ActiveOptions.configVersion;
    try {
      ActiveOptions.parseConfig();
    } catch {
      // No config.json here is fine; the version still moves first
    }
    expect(ActiveOptions.configVersion).to.be.greaterThan(before);
  });
});
