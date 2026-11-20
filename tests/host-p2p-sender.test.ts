import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * A P2P frame names its sender in a header anyone can write. It is handled
 * only when that reference is configured for the address the socket came
 * from, the same firewall every other neighbour route uses.
 */
describe("Host P2P frame sender check", () => {
  const real = Endpoints.InternalInitalise;
  let accepted: any[];

  const host = (): any =>
    Object.assign(Object.create(Host.prototype), {
      reference: "me",
      neighbourhood: {
        // peer-a is configured at 10.0.0.2 only
        checkFirewall: (addr: string, ref: string) => addr === "10.0.0.2" && ref === "peer-a",
      },
    });
  const frameFrom = (h: any, requester: string, remoteAddress: string) =>
    h.processEndpoints(
      { headers: { "X-Activeledger": requester }, method: "POST", url: "/a/init", connection: { remoteAddress } },
      null,
      { $umid: "u1" },
      requester,
      true
    );

  beforeEach(() => {
    accepted = [];
    (Endpoints as any).InternalInitalise = (...args: any[]) => {
      accepted.push(args);
      return Promise.resolve({ statusCode: 200, content: {} });
    };
  });
  afterEach(() => {
    (Endpoints as any).InternalInitalise = real;
  });

  it("handles a frame from the neighbour's own address", async () => {
    await frameFrom(host(), "peer-a", "10.0.0.2");
    expect(accepted).to.have.length(1);
    expect(accepted[0][4]).to.equal(true); // as P2P
  });

  it("drops a frame claiming a neighbour from another address", async () => {
    await frameFrom(host(), "peer-a", "6.6.6.6");
    expect(accepted).to.have.length(0);
  });

  it("drops a frame from a configured address claiming another neighbour", async () => {
    await frameFrom(host(), "peer-b", "10.0.0.2");
    expect(accepted).to.have.length(0);
  });

  it("drops a frame that names no sender", async () => {
    await frameFrom(host(), "NA", "10.0.0.2");
    expect(accepted).to.have.length(0);
  });
});
