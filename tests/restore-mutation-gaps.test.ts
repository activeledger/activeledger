import { expect } from "chai";
import "mocha";
import { Helper } from "../packages/restore/src/modules/helper/helper";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Throttle } from "../packages/restore/src/modules/helper/throttle";

/**
 * Edges a mutation pass over the restore package found nothing checking.
 */
describe("Restore - helper and throttle edges (Activerestore)", () => {
  const saved = { n: Provider.neighbourCount, c: Provider.consensusReachedAmount };
  afterEach(() => {
    Provider.neighbourCount = saved.n;
    Provider.consensusReachedAmount = saved.c;
  });

  it("metConsensus counts this node among the neighbours unless told otherwise", () => {
    Provider.neighbourCount = 5;
    Provider.consensusReachedAmount = 70;
    // 3 of 5 is 60%; 3 of the 4 others would be 75%
    expect(Helper.metConsensus(3)).to.equal(false);
    expect(Helper.metConsensus(3, true)).to.equal(true);
  });

  describe("Throttle", () => {
    const sleeper = () => {
      const slept: number[] = [];
      return { slept, sleep: async (ms: number) => void slept.push(ms) };
    };

    it("is switched off by fast = true only when asked, not by default", async () => {
      const { slept, sleep } = sleeper();
      const t = Throttle.fromConfig({ throttle: { pauseMs: 7 } }, undefined, sleep);
      await t.wait();
      expect(slept).to.deep.equal([7]);
    });

    it("treats a null throttle section like no section, with the defaults", async () => {
      const { slept, sleep } = sleeper();
      const t = Throttle.fromConfig({ throttle: null }, false, sleep);
      await t.wait();
      expect(slept).to.have.length(1);
      expect(slept[0]).to.be.greaterThan(0);
    });

    it("a fetch exactly as long as slowMs is not slow", async () => {
      const { slept, sleep } = sleeper();
      const t = Throttle.fromConfig(
        { throttle: { pauseMs: 0, batch: 1000, slowMs: 100, maxBackoffMs: 400 } },
        false,
        sleep
      );
      t.record(100);
      expect(t.backingOff).to.equal(0);
      t.record(101);
      expect(t.backingOff).to.equal(50);
      await t.wait();
      expect(slept).to.deep.equal([50]);
    });
  });
});
