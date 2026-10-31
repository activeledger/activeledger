import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";

// The origin node's stream-position self repair (SPI) inside
// ExternalInitalise: when the network disagrees with this node about a
// stream's revision, the origin asks every node, adopts the revision a
// majority agree on, and resubmits the transaction under a new umid.
describe("Endpoints.ExternalInitalise - origin SPI repair (Activeledger)", () => {
  const realRef = Home.reference;
  const realRepair = (Endpoints as any).repairHistoryInBackground;
  let repaired: string[];
  let n = 0;

  beforeEach(() => {
    Home.reference = "me";
    ActiveOptions.set("consensus", { reached: 66 });
    repaired = [];
    (Endpoints as any).repairHistoryInBackground = (_h: any, id: string) =>
      repaired.push(id);
  });
  afterEach(() => {
    Home.reference = realRef;
    ActiveOptions.set("consensus", undefined);
    (Endpoints as any).repairHistoryInBackground = realRepair;
  });

  const SPI = "Stream Position Incorrect";
  const spiVotes = () => ({
    me: { vote: false, commit: false, error: SPI },
    b: { vote: false, commit: false, error: SPI },
    c: { vote: false, commit: false, error: SPI },
  });

  const fixture = (stale: string, networkAnswers: () => Promise<any[]>) => {
    // Unique per test: the "already rewrote this" memory is process wide
    const streamId = `${++n}`.padStart(64, "e");
    const written: any[] = [];
    const released: any[] = [];
    const pendingCalls: any[] = [];
    const replies = [
      () =>
        Promise.resolve({
          status: 200,
          data: {
            $umid: "first",
            $tx: { $contract: "c".repeat(64), $i: { [streamId]: {} }, $o: {} },
            $nodes: spiVotes(),
          },
        }),
      () =>
        Promise.resolve({
          status: 200,
          data: {
            $umid: "second",
            $nodes: { me: { vote: true, commit: true } },
          },
        }),
    ];
    const host: any = {
      reference: "me",
      pending: (entry: any) => {
        pendingCalls.push(JSON.parse(JSON.stringify(entry)));
        return replies.shift()!();
      },
      release: (...a: any[]) => released.push(a),
      neighbourhood: { count: () => 4, knockAll: networkAnswers },
      dbConnection: {
        get: async () => ({ _id: streamId, _rev: stale }),
        bulkDocs: async (docs: any[], opts: any) => (
          written.push({ docs, opts }), { ok: true }
        ),
      },
    };
    return { host, streamId, written, released, pendingCalls };
  };

  const submit = (host: any) =>
    Endpoints.ExternalInitalise(
      host,
      {
        $tx: {
          $namespace: "default",
          $contract: "c".repeat(64),
          $i: { signer: {} },
        },
        $sigs: { signer: "s" },
      },
      "1.2.3.4",
      { exists: async () => false } as any
    );

  it("adopts the revision the majority reported, then resubmits under a fresh umid", async () => {
    let id = "";
    const f = fixture("1-stale", async () => {
      const winner = { _id: id, _rev: "2-winner" };
      return [[winner], [winner], [winner]];
    });
    id = f.streamId;

    const reply = await submit(f.host);

    // The winning document was written with its revision forced
    expect(f.written).to.have.length(1);
    expect(f.written[0].docs).to.deep.equal([{ _id: id, _rev: "2-winner" }]);
    expect(f.written[0].opts).to.deep.equal({
      new_edits: true,
      force_rev: "2-winner",
    });
    expect(repaired).to.deep.equal([id]);
    // Resubmitted: a different umid, without the first round's votes
    expect(f.pendingCalls).to.have.length(2);
    expect(f.pendingCalls[1].$umid).to.not.equal(f.pendingCalls[0].$umid);
    expect(f.pendingCalls[1].$nodes).to.equal(undefined);
    // The first round's locks were released before the retry
    expect(f.released[0][0]).to.equal(f.pendingCalls[0].$umid);
    // And the client gets the retried outcome
    expect(reply.content.$umid).to.equal("second");
    expect(reply.content.$summary.commit).to.equal(1);
  });

  it("leaves a document alone that already has the winning revision", async () => {
    let id = "";
    const f = fixture("2-winner", async () => {
      const winner = { _id: id, _rev: "2-winner" };
      return [[winner], [winner], [winner]];
    });
    id = f.streamId;

    const reply = await submit(f.host);

    expect(f.written).to.have.length(0);
    // Nothing changed so the client hears the failure, no resubmission
    expect(f.pendingCalls).to.have.length(1);
    expect(reply.statusCode).to.equal(200);
    expect(reply.content.$umid).to.equal("first");
    expect(reply.content.$summary.errors).to.deep.equal([SPI, SPI, SPI]);
    expect(f.released[0][0]).to.equal("first");
  });

  it("does not act on too few answers from the network", async () => {
    const f = fixture("1-stale", async () => []);

    const reply = await submit(f.host);

    expect(f.written).to.have.length(0);
    expect(f.pendingCalls).to.have.length(1);
    expect(reply.content.$umid).to.equal("first");
    expect(reply.content.$summary.commit).to.equal(0);
  });

  it("tells the client the original failure when the rewrite itself fails", async () => {
    let id = "";
    const f = fixture("1-stale", async () => {
      const winner = { _id: id, _rev: "2-winner" };
      return [[winner], [winner], [winner]];
    });
    id = f.streamId;
    // The store reports failures as anything but { ok: true }
    f.host.dbConnection.bulkDocs = async () => ({ error: "conflict" });

    const reply = await submit(f.host);

    expect(f.pendingCalls).to.have.length(1);
    expect(repaired).to.deep.equal([]);
    expect(reply.content.$summary.errors).to.deep.equal([SPI, SPI, SPI]);
  });
});

describe("Endpoints.streams - single revision lookups (Activeledger)", () => {
  it("returns the stream document at the revision asked for", async () => {
    const asked: any[] = [];
    const reply = await Endpoints.streams(
      {
        get: async (id: string, o: any) => (
          asked.push([id, o]), { _id: id, _rev: "3-abc" }
        ),
      } as any,
      { $stream: "s1", $rev: "3-abc" }
    );
    expect(asked).to.deep.equal([["s1", { _rev: "3-abc" }]]);
    expect(reply).to.deep.equal({
      statusCode: 200,
      content: { _id: "s1", _rev: "3-abc" },
    });
  });

  it("returns an empty list when the database answers with another revision", async () => {
    const reply = await Endpoints.streams(
      { get: async () => ({ _id: "s1", _rev: "4-other" }) } as any,
      { $stream: "s1", $rev: "3-abc" }
    );
    expect(reply).to.deep.equal({ statusCode: 200, content: [] });
  });

  it("returns an empty list when the revision is not there", async () => {
    const reply = await Endpoints.streams(
      { get: () => Promise.reject(new Error("missing")) } as any,
      { $stream: "s1", $rev: "3-abc" }
    );
    expect(reply).to.deep.equal({ statusCode: 200, content: [] });
  });

  it("refuses volatile streams with 403", async () => {
    let caught: any;
    await Endpoints.streams({} as any, {
      $stream: "s1:volatile",
      $rev: "1-a",
    }).catch((e: any) => (caught = e));
    expect(caught).to.deep.equal({
      statusCode: 403,
      content: "Request not allowed",
    });
  });

  it("answers 500 for a request that names neither streams nor a revision", async () => {
    for (const body of [{}, { $stream: "s1" }, { $rev: "1-a" }]) {
      let caught: any;
      await Endpoints.streams({} as any, body).catch((e: any) => (caught = e));
      expect(caught, JSON.stringify(body)).to.deep.equal({
        statusCode: 500,
        content: "Internal Server Error",
      });
    }
  });

  it("reports the locked streams alone when the database read fails", async () => {
    const reply = await Endpoints.streams(
      { allDocs: () => Promise.reject(new Error("io")) } as any,
      { $streams: ["a".repeat(64)] }
    );
    expect(reply).to.deep.equal({ statusCode: 200, content: [] });
  });
});
