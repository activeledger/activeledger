import { expect } from "chai";
import "mocha";
import { Throttle, DEFAULT_THROTTLE } from "../packages/restore/src/modules/helper/throttle";

describe("Throttle - keeping a full restore off the network (Activerestore)", () => {
  const make = (section: any = {}, fast = false) => {
    const slept: number[] = [];
    const t = Throttle.fromConfig(section, fast, async (ms) => void slept.push(ms));
    return { t, slept };
  };

  it("pauses before every stream and longer after every batch", async () => {
    const { t, slept } = make({ throttle: { pauseMs: 5, batch: 3, batchPauseMs: 100 } });
    for (let i = 0; i < 6; i++) await t.wait();
    expect(slept).to.deep.equal([5, 5, 105, 5, 5, 105]);
  });

  it("backs off while fetches are slow and eases down when they are not", async () => {
    const { t, slept } = make({ throttle: { pauseMs: 0, batch: 1000, slowMs: 100, maxBackoffMs: 400 } });
    t.record(500);
    await t.wait();
    t.record(500);
    await t.wait();
    t.record(500);
    t.record(500);
    t.record(500);
    await t.wait(); // capped
    t.record(10);
    await t.wait();
    expect(slept).to.deep.equal([50, 100, 400, 200]);
  });

  it("never waits when throttle is false or --fast is given", async () => {
    for (const [section, fast] of [[{ throttle: false }, false], [{}, true]] as const) {
      const { t, slept } = make(section, fast);
      await t.wait();
      t.record(99999);
      await t.wait();
      expect(slept).to.deep.equal([]);
    }
  });

  it("uses the defaults for anything missing or invalid", async () => {
    const { t, slept } = make({ throttle: { pauseMs: "lots", batch: -1 } });
    await t.wait();
    expect(slept).to.deep.equal([DEFAULT_THROTTLE.pauseMs]);
  });
});
