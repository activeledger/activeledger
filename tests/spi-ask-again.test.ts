import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * SPI asks the neighbours for their copy of a stream. When fewer than needed
 * answer it asks again, a few times, before it gives up: a node that is busy
 * or a moment behind often answers the second time.
 */
describe("SPI asks again when too few answer", () => {
  let asks: number;
  let waits: number[];
  const sleep = async (ms: number) => void waits.push(ms);

  /** A neighbourhood that answers with `counts[i]` copies on ask i (the last one repeats) */
  const hostAnswering = (counts: number[]): any => ({
    neighbourhood: {
      knockAll: async () => {
        const n = counts[Math.min(asks++, counts.length - 1)];
        return Array.from({ length: n }, () => [{ _id: "s", _rev: "1-a" }]);
      },
    },
  });

  beforeEach(() => {
    asks = 0;
    waits = [];
  });

  it("asks once when enough answer", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([3]), { $umid: "u" }, 2, 3, sleep);
    expect(answers).to.have.length(3);
    expect(asks).to.equal(1);
    expect(waits).to.deep.equal([]);
  });

  it("asks again, waiting longer each time, and stops once enough answer", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([0, 1, 2]), { $umid: "u" }, 2, 3, sleep);
    expect(answers).to.have.length(2);
    expect(asks).to.equal(3);
    expect(waits).to.deep.equal([Endpoints.SPI_ASK_WAIT, Endpoints.SPI_ASK_WAIT * 2]);
  });

  it("stops after the set number of asks and returns the last answers when never enough", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([0, 1, 1, 1, 1]), { $umid: "u" }, 3, 3, sleep);
    expect(asks).to.equal(3);
    expect(answers).to.have.length(1);
  });

  it("asks the same question each time", async () => {
    const bodies: any[] = [];
    const host: any = { neighbourhood: { knockAll: async (_p: string, body: any) => (bodies.push(body), []) } };
    await Endpoints.knockStreamsForSpi(host, { $streams: ["a", "a:stream"], $umid: "u" }, 1, 3, sleep);
    expect(bodies).to.have.length(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).to.equal(1);
  });

  it("asks once, and never waits, when told one try is all there is (someone is waiting for the answer)", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([0]), { $umid: "u" }, 2, 1, sleep);
    expect(answers).to.have.length(0);
    expect(asks).to.equal(1);
    expect(waits).to.deep.equal([]);
  });

  it("does not ask again when no answer is needed", async () => {
    await Endpoints.knockStreamsForSpi(hostAnswering([0]), { $umid: "u" }, 0, 3, sleep);
    expect(asks).to.equal(1);
  });

  describe("what counts as an answer", () => {
    const real = [{ _id: "s", _rev: "1-a" }];
    const busy = [{ _id: "s", locked: true }];

    /** Each ask returns the next list of per-node answers (the last repeats) */
    const hostReturning = (rounds: any[][]): any => ({
      neighbourhood: { knockAll: async () => rounds[Math.min(asks++, rounds.length - 1)] },
    });

    it("a node that could not report a stream (locked marker, no _rev) is not enough, so it asks again", async () => {
      const answers = await Endpoints.knockStreamsForSpi(hostReturning([[real, busy, busy], [real, real, real]]), { $umid: "u" }, 2, 2, sleep);
      expect(asks).to.equal(2);
      expect(answers.every((a: any) => a === real)).to.equal(true);
    });

    it("a failed knock ({ error: true }) is not enough, so it asks again", async () => {
      await Endpoints.knockStreamsForSpi(hostReturning([[real, { error: true, from: "n2" }, { error: true, from: "n3" }], [real, real, real]]), { $umid: "u" }, 2, 2, sleep);
      expect(asks).to.equal(2);
      expect(waits).to.deep.equal([Endpoints.SPI_ASK_WAIT]);
    });

    it("a stored document with a locked field and a _rev is a real answer", async () => {
      await Endpoints.knockStreamsForSpi(hostReturning([[[{ _id: "s", _rev: "1-a", locked: true }], real]]), { $umid: "u" }, 2, 2, sleep);
      expect(asks).to.equal(1);
    });

    it("an empty list (the node holds none of them) is an answer", async () => {
      await Endpoints.knockStreamsForSpi(hostReturning([[[], [], real]]), { $umid: "u" }, 3, 2, sleep);
      expect(asks).to.equal(1);
    });

    it("never asks again when one try is all there is, whatever came back", async () => {
      await Endpoints.knockStreamsForSpi(hostReturning([[busy, busy, { error: true }]]), { $umid: "u" }, 3, 1, sleep);
      expect(asks).to.equal(1);
      expect(waits).to.deep.equal([]);
    });

    it("still stops after the set number of asks when they stay busy", async () => {
      await Endpoints.knockStreamsForSpi(hostReturning([[busy, busy, busy]]), { $umid: "u" }, 2, 3, sleep);
      expect(asks).to.equal(3);
    });
  });
});
