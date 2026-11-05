import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";

const E: any = Endpoints;
const SPI = "Stream Position Incorrect";

describe("Origin SPI repair: a stream already rewritten (cov)", () => {
  const realRef = Home.reference;
  const realRepair = E.repairHistoryInBackground;
  let n = 5000;
  let repaired: string[];

  beforeEach(() => {
    Home.reference = "me";
    ActiveOptions.set("consensus", { reached: 66 });
    repaired = [];
    E.repairHistoryInBackground = (_h: any, id: string) => repaired.push(id);
  });
  afterEach(() => {
    Home.reference = realRef;
    ActiveOptions.set("consensus", undefined);
    E.repairHistoryInBackground = realRepair;
  });

  const build = (streamId: string, stale: string) => {
    const written: any[] = [];
    const released: any[] = [];
    const pendingCalls: any[] = [];
    const votes = () => ({
      me: { vote: false, commit: false, error: SPI },
      b: { vote: false, commit: false, error: SPI },
      c: { vote: false, commit: false, error: SPI },
    });
    const replies = [
      () => Promise.resolve({ status: 200, data: { $umid: "first", $tx: { $contract: "c".repeat(64), $i: { [streamId]: {} }, $o: {} }, $nodes: votes() } }),
      () => Promise.resolve({ status: 200, data: { $umid: "second", $nodes: { me: { vote: true, commit: true } } } }),
    ];
    const winner = { _id: streamId, _rev: "2-winner" };
    const host: any = {
      reference: "me",
      pending: (entry: any) => (pendingCalls.push(JSON.parse(JSON.stringify(entry))), replies.shift()!()),
      release: (...a: any[]) => released.push(a),
      neighbourhood: { count: () => 4, knockAll: async () => [[winner], [winner], [winner]] },
      dbConnection: {
        get: async () => ({ _id: streamId, _rev: stale }),
        bulkDocs: async (docs: any[], opts: any) => (written.push({ docs, opts }), { ok: true }),
      },
    };
    return { host, written, released, pendingCalls };
  };
  const submit = (host: any) =>
    Endpoints.ExternalInitalise(
      host,
      { $tx: { $namespace: "default", $contract: "c".repeat(64), $i: { signer: {} } }, $sigs: { signer: "s" } },
      "1.2.3.4",
      { exists: async () => false } as any
    );

  it("does not rewrite a stream a moment after rewriting it, and tells the client the failure", async () => {
    const id = `${++n}`.padStart(64, "r");
    const first = build(id, "1-stale");
    const r1 = await submit(first.host);
    expect(first.written).to.have.length(1);
    expect(r1.content.$umid).to.equal("second");

    const second = build(id, "1-stale");
    const r2 = await submit(second.host);
    expect(second.written).to.have.length(0);
    expect(second.pendingCalls).to.have.length(1);
    expect(r2.content.$umid).to.equal("first");
    expect(second.released[0][0]).to.equal("first");
    expect(repaired).to.deep.equal([id]);
  });
});

describe("Non-origin SPI repair paths (cov)", () => {
  const realRef = Home.reference;
  const realRepair = E.repairHistoryInBackground;
  const realBackfill = E.backfillUmid;
  let n = 7000;
  let repaired: string[];

  beforeEach(() => {
    Home.reference = "me";
    ActiveOptions.set("consensus", { reached: 66 });
    repaired = [];
    E.repairHistoryInBackground = (_h: any, id: string) => repaired.push(id);
    E.backfillUmid = async () => true;
  });
  afterEach(() => {
    Home.reference = realRef;
    ActiveOptions.set("consensus", undefined);
    E.repairHistoryInBackground = realRepair;
    E.backfillUmid = realBackfill;
  });

  interface Opts {
    entry?: any;
    unanimous?: boolean;
    meError?: string | null;
    nodes?: any;
    tx?: any;
    putFails?: boolean;
    bulk?: () => any;
    knock?: (id: string) => any[];
    known?: boolean;
    dontRelease?: boolean;
    replies?: (() => Promise<any>)[];
    id?: string;
  }

  const setup = (o: Opts = {}) => {
    const id = o.id || `${++n}`.padStart(64, "m");
    const winner = { _id: id, _rev: "5-winner" };
    const entry: any = o.entry || { $umid: `umid-${id}`, $tx: {}, $broadcast: true, $unanimous: o.unanimous !== false };
    const puts: any[] = [];
    const bulk: any[] = [];
    const errorDocs: any[] = [];
    const released: any[] = [];
    const pendingCalls: any[] = [];
    const nodes = o.nodes || {
      me: { vote: false, commit: false, ...(o.meError === null ? {} : { error: o.meError ?? SPI }) },
      b: { vote: true, commit: true },
    };
    const replies = o.replies || [
      () =>
        Promise.resolve({
          status: 200,
          ...(o.dontRelease ? { dontRelease: true } : {}),
          data: {
            $umid: entry.$umid,
            $tx: o.tx || { $contract: "c".repeat(64), $i: { [id]: {} }, $o: {} },
            $nodes: nodes,
          },
        }),
      // the retry of a unanimous transaction once its stream is repaired
      () => Promise.resolve({ status: 200, data: { $umid: entry.$umid, $nodes: { me: { vote: true, commit: true } } } }),
    ];
    const host: any = {
      reference: "me",
      pending: (e: any, ...rest: any[]) => (pendingCalls.push({ e, rest }), replies.shift()!()),
      release: (...a: any[]) => released.push(a),
      neighbourhood: { count: () => 4, knockAll: async () => (o.knock ? o.knock(id) : [[winner], [winner], [winner]]) },
      dbConnection: {
        get: async () => (o.known ? { _id: id, _rev: "4-old" } : {}),
        put: async (doc: any) => {
          if (o.putFails) throw new Error("put failed");
          puts.push(doc);
        },
        bulkDocs: async (docs: any[], opts: any) => (bulk.push({ docs, opts }), o.bulk ? o.bulk() : { ok: true }),
      },
      dbErrorConnection: { post: async (doc: any) => errorDocs.push(doc) },
    };
    return { host, entry, id, puts, bulk, errorDocs, released, pendingCalls };
  };
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

  describe("repair", () => {
    it("still rewrites the stream when creating its base document failed", async () => {
      const s = setup({ putFails: true });
      await Endpoints.InternalInitalise(s.host, s.entry, "10.0.0.2");
      expect(s.puts).to.deep.equal([]);
      expect(s.bulk).to.have.length(1);
      expect(s.bulk[0].docs).to.deep.equal([{ _id: s.id, _rev: "5-winner" }]);
    });

    it("does not count a failed rewrite as caught up, so there is no retry and nothing is backfilled for it", async () => {
      const s = setup({ known: true, bulk: () => ({ ok: false }) });
      const reply = await Endpoints.InternalInitalise(s.host, s.entry, "10.0.0.2");
      // unanimous waits for the repair; with nothing repaired the first answer stands
      expect(reply.statusCode).to.equal(200);
      expect(reply.content.$nodes.me.error).to.equal(SPI);
      expect(s.bulk).to.have.length(1);
      expect(s.pendingCalls).to.have.length(1);
      expect(repaired).to.deep.equal([]);
    });

    it("skips a stream that was rewritten moments ago", async () => {
      const id = `${++n}`.padStart(64, "k");
      const first = setup({ id, known: true });
      await Endpoints.InternalInitalise(first.host, first.entry, "10.0.0.2");
      expect(first.bulk).to.have.length(1);

      const second = setup({ id, known: true, entry: { $umid: "another-umid-" + id, $tx: {}, $broadcast: true, $unanimous: true } });
      const reply = await Endpoints.InternalInitalise(second.host, second.entry, "10.0.0.2");
      expect(second.bulk).to.have.length(0);
      expect(second.puts).to.have.length(0);
      expect(second.pendingCalls).to.have.length(1);
      expect(reply.content.$nodes.me.error).to.equal(SPI);
    });

    it("a unanimous transaction is retried once the stream is repaired, flagged as an SPI retry", async () => {
      const s = setup({ known: true });
      const reply = await Endpoints.InternalInitalise(s.host, s.entry, "10.0.0.2");
      expect(s.pendingCalls).to.have.length(2);
      // second submission: the retried flag is set so it cannot loop
      expect(s.pendingCalls[1].rest[1]).to.equal(true);
      expect(s.entry.$spiRetry).to.equal(true);
      expect(reply.content.$nodes.me).to.deep.equal({ vote: true, commit: true });
    });

    it("a transaction that is not unanimous is answered at once and repaired afterwards, without a retry", async () => {
      const s = setup({ known: true, unanimous: false });
      const reply = await Endpoints.InternalInitalise(s.host, s.entry, "10.0.0.2");
      expect(reply.content.$nodes.me.error).to.equal(SPI);
      expect(s.bulk).to.have.length(0);
      await settle();
      expect(s.bulk).to.have.length(1);
      expect(s.pendingCalls).to.have.length(1);
    });
  });

  describe("when no repair is needed", () => {
    const run = async (o: Opts) => {
      const s = setup({ unanimous: false, ...o });
      const reply = await Endpoints.InternalInitalise(s.host, s.entry, "10.0.0.2");
      await settle(5);
      return { s, reply };
    };

    it("releases the transaction and does not touch the database for a non position failure", async () => {
      const { s, reply } = await run({ meError: "Some other failure" });
      expect(reply.statusCode).to.equal(200);
      expect(s.released.map((r: any) => r[0])).to.deep.equal([s.entry.$umid]);
      expect(s.bulk).to.have.length(0);
    });

    it("releases, and answers a waiting unanimous transaction, when this node reported no error", async () => {
      const { s, reply } = await run({ meError: null, unanimous: true });
      expect(s.released.map((r: any) => r[0])).to.deep.equal([s.entry.$umid]);
      expect(reply.statusCode).to.equal(200);
      expect(reply.content.$nodes.me).to.deep.equal({ vote: false, commit: false });
    });

    it("releases when the response carries no node votes at all", async () => {
      const { s } = await run({
        replies: [() => Promise.resolve({ status: 200, data: { $umid: "x" } })],
        entry: { $umid: "no-nodes", $tx: {}, $broadcast: true },
      });
      expect(s.released.map((r: any) => r[0])).to.deep.equal(["no-nodes"]);
    });

    it("releases when no node committed and none but a plain position error was reported", async () => {
      const { s } = await run({
        nodes: { me: { vote: false, commit: false, error: "Output Position Incorrect" }, b: { vote: false, commit: false } },
      });
      expect(s.released.map((r: any) => r[0])).to.deep.equal([s.entry.$umid]);
      expect(s.bulk).to.have.length(0);
    });

    it("releases when the transaction names no stream to check", async () => {
      const { s } = await run({ tx: { $contract: "c".repeat(64), $i: { short: {} }, $o: {} } });
      expect(s.released.map((r: any) => r[0])).to.deep.equal([s.entry.$umid]);
      expect(s.bulk).to.have.length(0);
    });

    it("leaves the release to the owner when told not to release", async () => {
      const { s } = await run({ meError: "Some other failure", dontRelease: true });
      expect(s.released).to.deep.equal([]);
    });
  });
});
