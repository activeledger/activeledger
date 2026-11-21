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
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([3]), { $umid: "u" }, 2, sleep);
    expect(answers).to.have.length(3);
    expect(asks).to.equal(1);
    expect(waits).to.deep.equal([]);
  });

  it("asks again, waiting longer each time, and stops once enough answer", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([0, 1, 2]), { $umid: "u" }, 2, sleep);
    expect(answers).to.have.length(2);
    expect(asks).to.equal(3);
    expect(waits).to.deep.equal([Endpoints.SPI_ASK_WAIT, Endpoints.SPI_ASK_WAIT * 2]);
  });

  it("stops after the set number of asks and returns the last answers when never enough", async () => {
    const answers = await Endpoints.knockStreamsForSpi(hostAnswering([0, 1, 1, 1, 1]), { $umid: "u" }, 3, sleep);
    expect(asks).to.equal(Endpoints.SPI_ASK_TRIES);
    expect(answers).to.have.length(1);
  });

  it("asks the same question each time", async () => {
    const bodies: any[] = [];
    const host: any = { neighbourhood: { knockAll: async (_p: string, body: any) => (bodies.push(body), []) } };
    await Endpoints.knockStreamsForSpi(host, { $streams: ["a", "a:stream"], $umid: "u" }, 1, sleep);
    expect(bodies).to.have.length(Endpoints.SPI_ASK_TRIES);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).to.equal(1);
  });

  it("does not ask again when no answer is needed", async () => {
    await Endpoints.knockStreamsForSpi(hostAnswering([0]), { $umid: "u" }, 0, sleep);
    expect(asks).to.equal(1);
  });
});
