import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";
import { ActiveLogger } from "@activeledger/activelogger";

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

  const fixture = (
    stale: string,
    networkAnswers: () => Promise<any[]>,
    fixedId?: string
  ) => {
    // Unique per test: the "already rewrote this" memory is process wide
    const streamId = fixedId || `${++n}`.padStart(64, "e");
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

  it("does not rewrite when the network is forked at the same position", async () => {
    let id = "";
    const f = fixture("1-stale", async () => {
      const a = { _id: id, _rev: "2-aaaa" };
      const b = { _id: id, _rev: "2-bbbb" };
      return [[a], [a], [b], [b]];
    });
    id = f.streamId;

    const reply = await submit(f.host);

    // Either side's revision would destroy the other's transaction
    expect(f.written).to.have.length(0);
    expect(repaired).to.deep.equal([]);
    expect(f.pendingCalls).to.have.length(1);
    expect(reply.content.$umid).to.equal("first");
    expect(reply.content.$summary.errors).to.deep.equal([SPI, SPI, SPI]);
  });

  it("does not rewrite when the agreeing nodes are outnumbered by silent ones", async () => {
    let id = "";
    const f = fixture("1-stale", async () => {
      const winner = { _id: id, _rev: "2-winner" };
      const locked = { _id: id, locked: true };
      return [[winner], [winner], [locked], [locked]];
    });
    id = f.streamId;

    const reply = await submit(f.host);

    expect(f.written).to.have.length(0);
    expect(f.pendingCalls).to.have.length(1);
    expect(reply.content.$umid).to.equal("first");
  });

  it("does not ask the network anything when the failure is not a position error", async () => {
    let asked = 0;
    const f = fixture("1-stale", async () => (asked++, []));
    const other = "Deterministic Stream Name Exists";
    const firstReply = f.host.pending;
    f.host.pending = (entry: any) =>
      firstReply(entry).then((r: any) => {
        for (const k of Object.keys(r.data.$nodes)) {
          r.data.$nodes[k].error = other;
        }
        return r;
      });

    const reply = await submit(f.host);

    expect(asked).to.equal(0);
    expect(f.written).to.have.length(0);
    expect(reply.content.$summary.errors).to.deep.equal([other, other, other]);
  });

  it("resends the same transaction when a node answers 200 with no data", async () => {
    const f = fixture("1-stale", async () => []);
    const real = f.host.pending;
    let calls = 0;
    f.host.pending = (entry: any) => {
      calls++;
      if (calls === 1) {
        f.pendingCalls.push(JSON.parse(JSON.stringify(entry)));
        return Promise.resolve({ status: 200, data: undefined });
      }
      // Later calls follow the fixture's script (first round, then retry)
      return real(entry);
    };
    // The script has a "first" and a "second" reply; the empty answer
    // consumed neither, so the resend gets the SPI-failed first round.

    const reply = await submit(f.host);

    // Resent under the same umid, with the first attempt's node state gone
    expect(f.pendingCalls[1].$umid).to.equal(f.pendingCalls[0].$umid);
    expect(f.pendingCalls[1].$nodes).to.equal(undefined);
    // The empty answer's locks were released before the resend
    expect(f.released[0][0]).to.equal(f.pendingCalls[0].$umid);
    // The client got the answer of the resend, not an empty one
    expect(reply.content.$umid).to.equal("first");
  });

  describe("fork logging", () => {
    const realWarn = ActiveLogger.warn;
    const realError = ActiveLogger.error;
    const realNow = Date.now;
    let warns: string[];
    let errors: string[];
    let clock: number;

    beforeEach(() => {
      warns = [];
      errors = [];
      clock = 1_000_000;
      (ActiveLogger as any).warn = (m: any) => warns.push(String(m));
      (ActiveLogger as any).error = (m: any) => errors.push(String(m));
      Date.now = () => clock;
    });
    afterEach(() => {
      (ActiveLogger as any).warn = realWarn;
      (ActiveLogger as any).error = realError;
      Date.now = realNow;
    });

    const forked = (id: string) => async () => {
      const a = { _id: id, _rev: "2-aaaa" };
      const b = { _id: id, _rev: "2-bbbb" };
      return [[a], [b], [a], [b]];
    };
    const round = async (id: string, answers: (id: string) => any) => {
      const f = fixture("1-stale", answers(id), id);
      await submit(f.host);
      return f;
    };
    const forkId = () => `${++n}`.padStart(64, "f");

    it("logs a fork once, at error level, with the readable block and a JSON line", async () => {
      const id = forkId();
      const f = await round(id, forked);

      expect(errors).to.have.length(1);
      expect(warns.filter((w) => w.includes("NOWINNER"))).to.have.length(0);
      const entry = errors[0];
      expect(entry).to.contain(`stream ${id}`);
      expect(entry).to.contain("first"); // the umid that exposed it
      expect(entry).to.contain("2-aaaa");
      expect(entry).to.contain("2-bbbb");
      expect(entry).to.contain("NO action");
      const json = JSON.parse(entry.split("SPI_FORK ")[1]);
      expect(json.stream).to.equal(id);
      expect(json.umid).to.equal("first");
      expect(json.revisions.map((r: any) => r.nodes)).to.have.deep.members([
        [0, 2],
        [1, 3],
      ]);
      // Logging only: nothing was rewritten
      expect(f.written).to.have.length(0);
    });

    it("rate limits the same fork within the interval, then logs again with a count", async () => {
      const id = forkId();
      await round(id, forked);
      clock += Endpoints.FORK_LOG_INTERVAL_MS - 1;
      await round(id, forked);
      await round(id, forked);
      expect(errors).to.have.length(1);

      clock += 1;
      await round(id, forked);
      expect(errors).to.have.length(2);
      expect(errors[1]).to.contain("Seen 4 times since first logged");
      expect(errors[1]).to.contain("SPI_FORK ");
    });

    it("keeps a different forked stream's limit separate", async () => {
      await round(forkId(), forked);
      await round(forkId(), forked);
      expect(errors).to.have.length(2);
    });

    it("still warns, one line, for an abstention that is not a fork", async () => {
      const id = forkId();
      await round(id, (i) => async () => [
        [{ _id: i, _rev: "2-a" }],
        [{ _id: i, _rev: "2-b" }],
        [{ _id: i, _rev: "2-c" }],
        [{ _id: i, _rev: "2-d" }],
      ]);
      expect(errors).to.have.length(0);
      const w = warns.filter((x) => x.includes("SPI NOWINNER #1"));
      expect(w).to.have.length(1);
      expect(w[0]).to.contain(id);
      expect(w[0]).to.contain("no revision reached consensus");
    });
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

describe("Endpoints.InternalInitalise - non-origin SPI repair (Activeledger)", () => {
  const realRef = Home.reference;
  const realRepair = (Endpoints as any).repairHistoryInBackground;
  const realBackfill = Endpoints.backfillUmid;
  let n = 1000;

  afterEach(() => {
    Home.reference = realRef;
    ActiveOptions.set("consensus", undefined);
    (Endpoints as any).repairHistoryInBackground = realRepair;
    Endpoints.backfillUmid = realBackfill;
  });

  const run = async (opts: { stale: string; knownRev?: boolean; unanimous?: boolean }) => {
    Home.reference = "me";
    ActiveOptions.set("consensus", { reached: 66 });
    const repaired: string[] = [];
    const backfilled: string[] = [];
    (Endpoints as any).repairHistoryInBackground = (_h: any, id: string) =>
      repaired.push(id);
    Endpoints.backfillUmid = (async (_h: any, umid: string) => {
      backfilled.push(umid);
      return true;
    }) as any;

    const id = `${++n}`.padStart(64, "n");
    const winner = { _id: id, _rev: "5-winner" };
    const puts: any[] = [];
    const bulk: any[] = [];
    const errorDocs: any[] = [];
    const released: any[] = [];
    const entry: any = { $umid: `umid-${id}`, $tx: {}, $broadcast: true, $unanimous: opts.unanimous };
    const replies = [
      () =>
        Promise.resolve({
          status: 200,
          data: {
            $umid: entry.$umid,
            $tx: { $contract: "c".repeat(64), $i: { [id]: {} }, $o: {} },
            // This node disagrees with a network that committed
            $nodes: {
              me: { vote: false, commit: false, error: "Stream Position Incorrect" },
              b: { vote: true, commit: true },
            },
          },
        }),
    ];
    const host: any = {
      reference: "me",
      pending: () => replies.shift()!(),
      release: (...a: any[]) => released.push(a),
      neighbourhood: {
        count: () => 4,
        knockAll: async () => [[winner], [winner], [winner]],
      },
      dbConnection: {
        get: async () => (opts.knownRev ? { _id: id, _rev: opts.stale } : {}),
        put: async (doc: any) => puts.push(doc),
        bulkDocs: async (docs: any[], o: any) => (bulk.push({ docs, o }), { ok: true }),
      },
      dbErrorConnection: { post: async (doc: any) => errorDocs.push(doc) },
    };
    const reply = await Endpoints.InternalInitalise(host, entry, "10.0.0.2");
    // The repair runs a moment after the neighbour has been answered
    await new Promise((r) => setTimeout(r, 700));
    return { reply, id, puts, bulk, errorDocs, released, repaired, backfilled, entry };
  };

  it("answers the neighbour first, then rewrites the stream to the revision the network agreed", async () => {
    const r = await run({ stale: "4-old", knownRev: true });

    expect(r.reply.statusCode).to.equal(200);
    expect(r.bulk).to.have.length(1);
    expect(r.bulk[0].o).to.deep.equal({ new_edits: true, force_rev: "5-winner" });
    // The stream existed, so no base document is created first
    expect(r.puts).to.have.length(0);
    expect(r.repaired).to.deep.equal([r.id]);
    expect(r.backfilled).to.deep.equal([r.entry.$umid]);
    // A 950 checker is left so the missing umid is looked for later
    expect(r.errorDocs).to.have.length(1);
    expect(r.errorDocs[0]).to.include({ code: 950, processed: false, umid: r.entry.$umid });
    expect(r.released.map((x: any) => x[0])).to.include(r.entry.$umid);
  });

  it("creates the stream first when this node had never seen it", async () => {
    const r = await run({ stale: "", knownRev: false });

    expect(r.puts).to.deep.equal([{ _id: r.id, _rev: "5-winner" }]);
    expect(r.bulk).to.have.length(1);
  });
});
