import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";

const hostWith = (neighbours: { [ref: string]: any }) =>
  ({ neighbourhood: { get: (ref?: string) => (ref ? neighbours[ref] : neighbours), keys: () => Object.keys(neighbours) } }) as any;

describe("Neighbour status and the chain id", () => {
  let saved: any;
  before(() => {
    ActiveOptions.init();
    saved = ActiveOptions.get<any>("chain", null);
  });
  after(() => ActiveOptions.set("chain", saved));

  const host = hostWith({ peer: { graceStop: false } });

  it("pairs a neighbour on the same chain", async () => {
    ActiveOptions.set("chain", { id: 5 });
    expect((await Endpoints.status(host, "peer", "5", "10.0.0.2")).statusCode).to.equal(200);
  });

  it("refuses a neighbour on another chain, even one it knows", async () => {
    ActiveOptions.set("chain", { id: 1 });
    const res = await Endpoints.status(host, "peer", "5", "10.0.0.2");
    expect(res.statusCode).to.equal(403);
    // The asker reads only the body, so the refusal must be in it
    expect(res.content).to.deep.equal({ chainMismatch: 1 });
  });

  it("lets through a neighbour that sends no chain (an older node)", async () => {
    ActiveOptions.set("chain", { id: 1 });
    expect((await Endpoints.status(host, "peer", undefined, "10.0.0.2")).statusCode).to.equal(200);
  });
});
