import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
// By package name: the setup contract and extendConfig use the built lib's
// ActiveOptions, a different module instance from ../packages/options/src
import {
  ActiveOptions,
  ActiveDSConnect,
  HybridConfig,
} from "@activeledger/activeoptions";
import Setup from "../packages/activeledger/src/contracts/default/setup";

// The `hybrid` section is asserted on-ledger into the setup stream, beside
// security and consensus, so every supernode enforces and serves the same
// hybrid rules.
describe("Hybrid config section", () => {
  const id = "c".repeat(64);
  const valid = () => ({
    admission: "open",
    required: [id, { id, volatile: true }],
    window: { days: 30 },
    minVersion: "5.1.0",
  });

  describe("validation", () => {
    it("accepts the documented shape", () => {
      expect(HybridConfig.validate(valid())).to.equal(null);
      expect(
        HybridConfig.validate({
          ...valid(),
          admission: { allowlist: ["k1", "k2"] },
          required: [],
          minVersion: "5.1.0-beta.1+build.7",
        })
      ).to.equal(null);
    });

    it("refuses anything else", () => {
      const bad: any[] = [
        null,
        [],
        "open",
        { ...valid(), extra: true },
        { ...valid(), admission: "closed" },
        { ...valid(), admission: { allowlist: "k1" } },
        { ...valid(), admission: { allowlist: [""] } },
        { ...valid(), admission: { allowlist: [], other: 1 } },
        { ...valid(), required: "x" },
        { ...valid(), required: ["not-a-stream-id"] },
        { ...valid(), required: [{ id, volatile: "yes" }] },
        { ...valid(), required: [{ id, extra: 1 }] },
        { ...valid(), window: { days: 0 } },
        { ...valid(), window: { days: 1.5 } },
        { ...valid(), window: 30 },
        { ...valid(), minVersion: "v5.1.0" },
        { ...valid(), minVersion: "5.1" },
        { ...valid(), minVersion: "05.1.0" },
        { ...valid(), minVersion: 510 },
        (({ admission, ...rest }) => rest)(valid()),
        (({ minVersion, ...rest }) => rest)(valid()),
      ];
      for (const value of bad) {
        expect(HybridConfig.validate(value), JSON.stringify(value)).to.be.a(
          "string"
        );
      }
    });

    it("does not take the legacy hybrid[] URL list for a section", () => {
      expect(HybridConfig.isSection([])).to.equal(false);
      expect(HybridConfig.isSection(undefined)).to.equal(false);
      expect(HybridConfig.isSection(valid())).to.equal(true);
    });
  });

  describe("setup contract assert", () => {
    let originalBuild: any;

    beforeEach(() => {
      originalBuild = ActiveOptions.get("build", 0);
    });

    afterEach(() => {
      ActiveOptions.set("build", originalBuild);
    });

    const neighbourhood = [
      { identity: { type: "rsa", public: "x" }, host: "127.0.0.1", port: 5260 },
    ];

    const assert = (hybrid?: any) => {
      const setup = new (Setup as any)(
        new Date(),
        "127.0.0.1",
        "a".repeat(64),
        {
          $namespace: "default",
          $contract: "setup",
          $entry: "assert",
          $i: {
            setup: {
              security: {},
              consensus: { reached: 60 },
              neighbourhood,
              ...(hybrid !== undefined ? { hybrid } : {}),
            },
          },
        },
        [],
        [],
        {},
        {},
        {},
        0,
        new EventEmitter(),
        "127.0.0.1:5260"
      ) as Setup;
      setup.sysConfig({ neighbourhood });
      return setup;
    };

    const stateOf = (setup: Setup): any =>
      (Object.values(setup.getActivityStreams())[0] as any).getState();

    it("copies the hybrid section into the setup stream at build 40300", async () => {
      ActiveOptions.set("build", 40300);
      const setup = assert(valid());
      await setup.verify!(true);
      await setup.commit();
      const state = stateOf(setup);
      expect(state.hybrid).to.deep.equal(valid());
      expect(state.consensus).to.deep.equal({ reached: 60 });
    });

    it("refuses an invalid hybrid section at build 40300", async () => {
      ActiveOptions.set("build", 40300);
      let error: any;
      await assert({ ...valid(), minVersion: "latest" })
        .verify!(true)
        .catch((e) => (error = e));
      expect(error).to.equal("hybrid.minVersion must be a semver version");
    });

    it("writes exactly what it wrote before below 40300", async () => {
      ActiveOptions.set("build", 40200);
      const setup = assert({ ...valid(), minVersion: "latest" });
      await setup.verify!(true);
      await setup.commit();
      expect("hybrid" in stateOf(setup)).to.equal(false);
    });

    it("never asserts the legacy hybrid[] list", async () => {
      ActiveOptions.set("build", 40300);
      const setup = assert([]);
      await setup.verify!(true);
      await setup.commit();
      expect("hybrid" in stateOf(setup)).to.equal(false);
    });
  });

  describe("merge from the ledger", () => {
    let originalGet: any;
    let originalNetwork: any;
    let originalHybrid: any;

    beforeEach(() => {
      originalGet = ActiveDSConnect.prototype.get;
      originalNetwork = ActiveOptions.get("network", "");
      originalHybrid = ActiveOptions.get("hybrid", undefined);
      ActiveOptions.set("network", "setupstream@1-a");
    });

    afterEach(() => {
      ActiveDSConnect.prototype.get = originalGet;
      ActiveOptions.set("network", originalNetwork);
      ActiveOptions.set("hybrid", originalHybrid);
    });

    const ledger = (doc: any) => {
      ActiveDSConnect.prototype.get = function () {
        return Promise.resolve({ _id: "setupstream", _rev: "2-b", ...doc });
      } as any;
    };

    it("takes the hybrid section from the setup stream", async () => {
      ledger({ hybrid: valid() });
      ActiveOptions.set("hybrid", { admission: "open" });
      await ActiveOptions.extendConfig();
      expect(ActiveOptions.get("hybrid")).to.deep.equal(valid());
    });

    it("ignores a local section once asserted, even if the ledger has none", async () => {
      ledger({});
      ActiveOptions.set("hybrid", { admission: { allowlist: [] } });
      await ActiveOptions.extendConfig();
      expect(ActiveOptions.get("hybrid", null)).to.equal(null);
    });
  });
});
