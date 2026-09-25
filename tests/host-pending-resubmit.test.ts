import { Host } from "../packages/network/src/network/host";
import { expect } from "chai";
import "mocha";

// A rejected transaction stays in processPending, finished, for a few
// minutes after release(). If a client resubmits the identical bytes in that
// window, the endpoint has already set $broadcast on it, so it takes the
// "already pending" branch that was written for neighbour broadcasts - but a
// client entry carries no $nodes. `delete entry.$nodes[...]` threw inside the
// async Promise executor, which went unhandled and exited the host process.
describe("Host.pending - resubmitting a finished transaction (Activenetwork)", () => {
  const UMID = "resubmitted-umid";

  // Just enough of a Host for pending() to reach the broadcast merge branch
  const fakeHost = (overrides: any = {}): any => ({
    reference: "me",
    host: "127.0.0.1",
    neighbourhood: { checkFirewall: () => true },
    broadcast: () => {},
    findProcessor: () => undefined,
    processPending: {
      [UMID]: {
        entry: {
          $umid: UMID,
          $broadcast: true,
          $nodes: {
            me: { vote: false, commit: false, error: "Stream(s) not found" },
            other: { vote: false, commit: false },
          },
        },
        pid: 1,
        finished: true,
        responded: true,
      },
    },
    ...overrides,
  });

  // What the endpoint hands pending() for a client post: $broadcast, no $nodes
  const clientEntry = (): any => ({ $umid: UMID, $broadcast: true, $tx: {} });

  it("answers a client resubmission with the recorded outcome instead of crashing", async () => {
    const host = fakeHost();
    const recorded = host.processPending[UMID].entry;

    const response = await Host.prototype.pending.call(
      host,
      clientEntry(),
      "10.0.0.9",
      true
    );

    expect(response.status).to.equal(200);
    expect(response.data).to.equal(recorded);
    expect(recorded.$nodes.me.error).to.equal("Stream(s) not found");
    expect(Object.keys(recorded.$nodes)).to.deep.equal(["me", "other"]);
  });

  it("still merges a neighbour broadcast's votes, without overwriting self", async () => {
    const host = fakeHost();
    const recorded = host.processPending[UMID].entry;

    await Host.prototype.pending.call(
      host,
      {
        ...clientEntry(),
        $$noreply: true,
        $nodes: {
          me: { vote: true, commit: true },
          third: { vote: false, commit: false },
        },
      },
      "10.0.0.9",
      true
    );

    expect(recorded.$nodes.me.error).to.equal("Stream(s) not found");
    expect(recorded.$nodes).to.have.property("third");
  });

  it("rejects, rather than throwing out of the executor, when the handler fails", async () => {
    const host = fakeHost({
      broadcast: () => {
        throw new Error("boom");
      },
    });

    let caught: any;
    await Host.prototype.pending
      .call(host, clientEntry(), "10.0.0.9", true)
      .catch((error: any) => (caught = error));

    expect(caught).to.be.an("error");
    expect(caught.message).to.equal("boom");
  });
});
