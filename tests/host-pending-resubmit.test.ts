import { Host } from "../packages/network/src/network/host";
import { Process } from "../packages/protocol/src/protocol/process";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Locker } from "../packages/network/src/network/locker";
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

  it("doesn't forward a mid-flight client resubmission to the processor", async () => {
    const sent: any[] = [];
    const host = fakeHost({
      findProcessor: () => ({ send: (m: any) => sent.push(m) }),
    });
    // Original is still being processed on this node
    host.processPending[UMID].finished = false;
    host.processPending[UMID].entry.$nodes = {};

    const response = await Host.prototype.pending.call(
      host,
      clientEntry(),
      "10.0.0.9",
      true
    );

    expect(response.status).to.equal(200);
    expect(sent).to.deep.equal([]);
  });

  it("still forwards a mid-flight neighbour broadcast to the processor", async () => {
    const sent: any[] = [];
    const host = fakeHost({
      findProcessor: () => ({ send: (m: any) => sent.push(m) }),
    });
    host.processPending[UMID].finished = false;
    host.processPending[UMID].entry.$nodes = {};

    await Host.prototype.pending.call(
      host,
      { ...clientEntry(), $$noreply: true, $nodes: { other: { vote: true } } },
      "10.0.0.9",
      true
    );

    expect(sent).to.have.length(1);
    expect(sent[0].data.nodes).to.deep.equal({ other: { vote: true } });
  });
});

// The processor side of the same replay: whatever reaches it, a broadcast
// with no node data must not throw in the processor child.
describe("Process.updatedFromBroadcast - no node data (Activeprotocol)", () => {
  it("ignores an undefined nodes payload", () => {
    const fake: any = {
      reference: "me",
      isCommiting: () => false,
      entry: { $nodes: { me: { vote: false } } },
    };

    expect(() =>
      Process.prototype.updatedFromBroadcast.call(fake, undefined)
    ).to.not.throw();
    expect(fake.entry.$nodes).to.deep.equal({ me: { vote: false } });
  });
});

// A replay's own failure must never release the original it collided with.
// The endpoint releases the umid after any pending() rejection, and release()
// frees whatever locks the pending entry under that umid holds - so a replay
// rejected while the original was mid-commit used to free the original's
// stream locks out from under it.
describe("Endpoints - a rejected replay doesn't release the original (Activenetwork)", () => {
  const UMID = "in-flight-umid";
  let released: string[];
  let lockerRelease: any;

  beforeEach(() => {
    released = [];
    lockerRelease = Locker.release;
    (Locker as any).release = (_streams: any, umid: string) => {
      released.push(umid);
      return true;
    };
  });

  afterEach(() => {
    (Locker as any).release = lockerRelease;
  });

  // A host whose handler throws after the pending lookup, the way a replay
  // rejects via pending()'s catch. pending/release are the real ones.
  const fakeHost = (original: any): any => {
    const host: any = {
      reference: "me",
      host: "127.0.0.1",
      neighbourhood: { checkFirewall: () => true },
      broadcast: () => {
        throw new Error("boom");
      },
      findProcessor: () => undefined,
      processQueue: () => {},
      labelOrKey: () => [],
      destroy: () => {},
      processPending: {},
    };
    if (original) {
      host.processPending[UMID] = {
        entry: original,
        pid: 1,
        finished: false,
        responded: false,
      };
    }
    host.pending = Host.prototype.pending.bind(host);
    host.release = Host.prototype.release.bind(host);
    return host;
  };

  const entry = (): any => ({
    $umid: UMID,
    $broadcast: true,
    $tx: { $i: { a: {} }, $o: { b: {} } },
  });

  it("leaves the in-flight original's locks alone when the replay rejects", async () => {
    // Still being processed: the replay takes the in-flight branch, then
    // the stubbed broadcast throws and pending() rejects
    const original = { ...entry(), $nodes: { me: { vote: true } } };
    const host = fakeHost(original);

    let caught: any;
    await (Endpoints as any)
      .DirectInternalInitalise(host, entry())
      .catch((error: any) => (caught = error));

    expect(caught).to.be.an("error");
    expect(released).to.deep.equal([]);
    expect(host.processPending[UMID].entry).to.equal(original);
  });

  it("leaves it alone when a spoofed peer copy is rejected as a bad neighbour", async () => {
    const original = entry();
    const host = fakeHost(original);
    host.neighbourhood.checkFirewall = () => false;

    let caught: any;
    await Endpoints.InternalInitalise(
      host,
      { ...entry(), $nodes: { someone: { vote: true } } },
      "10.0.0.66"
    ).catch((error: any) => (caught = error));

    expect(caught.content).to.equal("Bad Neighbour Payload");
    expect(released).to.deep.equal([]);
  });

  it("still releases when the rejected entry is the caller's own", () => {
    const own = entry();
    const host = fakeHost(own);

    host.release(UMID, own);

    expect(released).to.deep.equal([UMID]);
  });

  it("keeps the old behaviour for callers that don't say whose entry it is", () => {
    const host = fakeHost(entry());

    host.release(UMID);

    expect(released).to.deep.equal([UMID]);
  });
});
