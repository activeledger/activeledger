import { expect } from "chai";
import "mocha";
import { gzipSync } from "zlib";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";

const E: any = Endpoints;

describe("Endpoints small helpers (cov)", () => {
  it("filterPrefix keeps the last 64 characters of a prefixed id", () => {
    const id = "c".repeat(64);
    expect(Endpoints.filterPrefix(id)).to.equal(id);
    expect(Endpoints.filterPrefix("ab" + id)).to.equal(id);
    expect(Endpoints.filterPrefix("short")).to.equal("short");
    expect(Endpoints.filterPrefix("x" + id)).to.equal(id);
  });

  it("labelOrKey returns stream ids (trimmed to 64), preferring the $stream label, and drops anything else", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const out = Endpoints.labelOrKey({
      [a]: {},
      label: { $stream: "zz" + b },
      "not-a-stream": {},
    });
    expect(out.sort()).to.deep.equal([a, b]);
    expect(Endpoints.labelOrKey(undefined)).to.deep.equal([]);
  });

  it("revPosition reads the position of a revision", () => {
    expect(Endpoints.revPosition("39-abcdef")).to.equal(39);
    expect(Endpoints.revPosition("1-a")).to.equal(1);
    expect(Endpoints.revPosition("")).to.equal(0);
    expect(Endpoints.revPosition("garbage")).to.equal(0);
  });

  it("previousUmidFor finds the umid a transaction replaced on a stream", () => {
    const doc = {
      streams: {
        updated: [
          null,
          { id: "", prev: "nope" },
          { id: "other", prev: "no" },
          { id: "ab" + "c".repeat(64), prev: "umid-before" },
          { id: "d".repeat(64) },
        ],
      },
    };
    expect(E.previousUmidFor(doc, "c".repeat(64))).to.equal("umid-before");
    expect(E.previousUmidFor(doc, "d".repeat(64))).to.equal(undefined);
    expect(E.previousUmidFor(doc, "e".repeat(64))).to.equal(undefined);
    expect(E.previousUmidFor({}, "x")).to.equal(undefined);
  });

  describe("makeSureNotBuffer (JSON form)", () => {
    const call = (v: unknown) => E.makeSureNotBuffer(v);
    it("parses a wrapped Buffer, plain or gzip", async () => {
      expect(await call({ type: "Buffer", data: [...Buffer.from('{"a":1}')] })).to.deep.equal({ a: 1 });
      expect(await call({ type: "Buffer", data: [...gzipSync(Buffer.from('{"b":2}'))] })).to.deep.equal({ b: 2 });
    });
    it("passes anything else straight through", async () => {
      const empty = { type: "Buffer", data: [] };
      expect(await call(empty)).to.equal(empty);
      const other = { type: "Other", data: [1] };
      expect(await call(other)).to.equal(other);
      const plain = { x: 1 };
      expect(await call(plain)).to.equal(plain);
    });
  });

  describe("ExternalEncrypt with the header", () => {
    const realRef = Home.reference;
    const realPem = Home.publicPem;
    const realIdentity = Home.identity;
    const proto: any = (ActiveCrypto as any).Secured.prototype;
    const realEncrypt = proto.encrypt;
    let logged: any[][];
    const realError = (ActiveLogger as any).error;

    beforeEach(() => {
      logged = [];
      (ActiveLogger as any).error = (...a: any[]) => logged.push(a);
      Home.reference = "me";
      Home.publicPem = Buffer.from("PUBLIC PEM").toString("base64");
      Home.identity = { pem: "PRIVATE PEM" } as any;
    });
    afterEach(() => {
      proto.encrypt = realEncrypt;
      (ActiveLogger as any).error = realError;
      Home.reference = realRef;
      Home.publicPem = realPem;
      Home.identity = realIdentity;
    });

    const host: any = { neighbourhood: { get: () => ({}) } };

    it("answers 200 with the encrypted body", async () => {
      let seen: any;
      proto.encrypt = async function (body: any) {
        seen = body;
        return { $packet: "sealed" };
      };
      const r = await Endpoints.ExternalEncrypt(host, { secret: 1 }, true, {} as any);
      expect(seen).to.deep.equal({ secret: 1 });
      expect(r).to.deep.equal({ statusCode: 200, content: { $packet: "sealed" } });
    });

    it("answers 500 with the error when encryption fails", async () => {
      const failure = new Error("cannot seal");
      proto.encrypt = async () => {
        throw failure;
      };
      let caught: any;
      await Endpoints.ExternalEncrypt(host, {}, true, {} as any).catch((e: any) => (caught = e));
      expect(caught).to.deep.equal({ statusCode: 500, content: failure });
      expect(logged[0][1]).to.equal("Sent 500 Response (1300)");
    });
  });

  describe("replaySpiEvents", () => {
    it("posts each event of a backfilled umid, one failing not costing the others", async () => {
      const posted: any[] = [];
      const host: any = {
        dbConnection: {},
        dbEventConnection: {
          post: async (e: any) => {
            if (e._id === "bad") throw new Error("nope");
            posted.push(e);
          },
        },
      };
      const realError = (ActiveLogger as any).error;
      const realWarn = (ActiveLogger as any).warn;
      (ActiveLogger as any).error = () => undefined;
      (ActiveLogger as any).warn = () => undefined;
      try {
        await E.replaySpiEvents(host, { umid: { $umid: "u" }, events: [{ _id: "e1" }, { _id: "bad" }, { _id: "e2" }] });
      } finally {
        (ActiveLogger as any).error = realError;
        (ActiveLogger as any).warn = realWarn;
      }
      expect(posted.map((e) => e._id).sort()).to.deep.equal(["e1", "e2"]);
    });

    it("does nothing for a umid with no events", async () => {
      let posts = 0;
      const host: any = { dbEventConnection: { post: async () => posts++ } };
      await E.replaySpiEvents(host, { umid: {} });
      await E.replaySpiEvents(host, { events: [] });
      expect(posts).to.equal(0);
    });
  });

  describe("fork log memory", () => {
    const realMax = E.FORK_LOG_MAX;
    const realError = (ActiveLogger as any).error;
    beforeEach(() => {
      E.forkLog.clear();
      (ActiveLogger as any).error = () => undefined;
    });
    afterEach(() => {
      E.FORK_LOG_MAX = realMax;
      E.forkLog.clear();
      (ActiveLogger as any).error = realError;
    });
    const fork: any = { revisions: [{ rev: "2-a", nodes: [0] }, { rev: "2-b", nodes: [1] }], nodes: 2 };

    it("forgets the oldest stream once the limit is passed, and keeps the newest", () => {
      E.FORK_LOG_MAX = 2;
      E.logAbstention("#t", "s1", "r", fork, "u");
      E.logAbstention("#t", "s2", "r", fork, "u");
      expect([...E.forkLog.keys()]).to.deep.equal(["s1", "s2"]);
      E.logAbstention("#t", "s3", "r", fork, "u");
      expect([...E.forkLog.keys()]).to.deep.equal(["s2", "s3"]);
    });
  });

  describe("history repair cooldown memory", () => {
    afterEach(() => E.historyRepairLastRun.clear());

    it("leaves a small map alone", () => {
      E.historyRepairLastRun.clear();
      E.historyRepairLastRun.set("old", 1);
      E.pruneHistoryRepairMemory();
      expect(E.historyRepairLastRun.has("old")).to.equal(true);
    });

    it("sweeps entries older than the cooldown once the map is large, keeping the recent ones", () => {
      E.historyRepairLastRun.clear();
      const now = Date.now();
      for (let i = 0; i < 1000; i++) E.historyRepairLastRun.set(`old-${i}`, now - E.HISTORY_REPAIR_COOLDOWN_MS - 1000);
      E.historyRepairLastRun.set("recent", now);
      E.historyRepairLastRun.set("edge", now - E.HISTORY_REPAIR_COOLDOWN_MS + 5000);
      E.pruneHistoryRepairMemory();
      expect([...E.historyRepairLastRun.keys()].sort()).to.deep.equal(["edge", "recent"]);
    });

    it("keeps the map at 999 entries untouched (the sweep starts at 1000)", () => {
      E.historyRepairLastRun.clear();
      for (let i = 0; i < 999; i++) E.historyRepairLastRun.set(`old-${i}`, 1);
      E.pruneHistoryRepairMemory();
      expect(E.historyRepairLastRun.size).to.equal(999);
    });
  });
});

describe("Endpoints post-commit history repair details (cov)", () => {
  const STREAM = "a".repeat(64);
  let n = 0;
  beforeEach(() => {
    E.historyRepairLastRun.clear();
    E.historyRepairInFlight.clear();
  });

  const hostFor = (majority: any, held: (id: string) => boolean = () => false) => {
    const gets: string[] = [];
    const knocks: string[] = [];
    return {
      gets,
      knocks,
      host: {
        dbConnection: {
          get: async (id: string) => {
            gets.push(id);
            if (id.endsWith(":umid") && held(id)) return { _id: id };
            throw new Error("missing");
          },
        },
        neighbourhood: {
          knockAll: async (endpoint: string) => {
            knocks.push(endpoint);
            return majority;
          },
        },
      } as any,
    };
  };
  const umid = () => `cov-umid-${Date.now()}-${n++}`;

  it("checks nothing when the network's copy of the transaction updated no stream", async () => {
    const id = umid();
    const { host, gets, knocks } = hostFor([{ streams: { new: [], updated: [] } }]);
    await Endpoints.repairHistoryAfterCommit(host, id, [STREAM]);
    expect(knocks).to.deep.equal([`umid/${id}`]);
    expect(gets).to.deep.equal([]);
  });

  it("checks nothing when no node can describe the transaction", async () => {
    const id = umid();
    const { host, gets, knocks } = hostFor([null, {}]);
    await Endpoints.repairHistoryAfterCommit(host, id, [STREAM]);
    expect(knocks).to.have.length(1);
    expect(gets).to.deep.equal([]);
  });

  it("skips creations and entries with nothing to follow, and streams whose previous umid is held", async () => {
    const id = umid();
    const walked: any[] = [];
    const realWalk = E.walkUmidHistory;
    E.walkUmidHistory = async (_h: any, stream: string, prev: string) => {
      walked.push([stream, prev]);
      return { recovered: [], complete: true, stoppedAt: "start of history" };
    };
    try {
      const doc = {
        streams: {
          updated: [
            { id: STREAM },
            { prev: "p0" },
            { id: "b".repeat(64), prev: "held-before" },
            { id: "c".repeat(64), prev: "lost-before" },
          ],
        },
      };
      const { host, gets } = hostFor([doc], (g) => g === "held-before:umid");
      await Endpoints.repairHistoryAfterCommit(host, id, [STREAM]);
      expect(gets).to.deep.equal(["held-before:umid", "lost-before:umid"]);
      expect(walked).to.deep.equal([["c".repeat(64), "lost-before"]]);
    } finally {
      E.walkUmidHistory = realWalk;
    }
  });

  it("follows the copy the most nodes agree on", async () => {
    const id = umid();
    const walked: any[] = [];
    const realWalk = E.walkUmidHistory;
    E.walkUmidHistory = async (_h: any, stream: string, prev: string) => {
      walked.push([stream, prev]);
      return { recovered: [], complete: true, stoppedAt: "x" };
    };
    try {
      const good = { streams: { updated: [{ id: STREAM, prev: "good-prev" }] } };
      const odd = { streams: { updated: [{ id: STREAM, prev: "odd-prev" }] } };
      const { host } = hostFor([odd, good, good]);
      await Endpoints.repairHistoryAfterCommit(host, id, [STREAM]);
      expect(walked).to.deep.equal([[STREAM, "good-prev"]]);
    } finally {
      E.walkUmidHistory = realWalk;
    }
  });
});

describe("Endpoints.repairHistoryInBackground (cov)", () => {
  const realCurrent = E.currentUmidFor;
  const realWalk = E.walkUmidHistory;
  const realRecord = E.recordIncompleteWalk;
  const realWarn = (ActiveLogger as any).warn;
  const realError = (ActiveLogger as any).error;
  let warns: string[];
  let errors: any[][];
  let recorded: any[][];

  beforeEach(() => {
    warns = [];
    errors = [];
    recorded = [];
    (ActiveLogger as any).warn = (m: any) => warns.push(String(m));
    (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
    E.recordIncompleteWalk = async (...a: any[]) => recorded.push(a);
  });
  afterEach(() => {
    E.currentUmidFor = realCurrent;
    E.walkUmidHistory = realWalk;
    E.recordIncompleteWalk = realRecord;
    (ActiveLogger as any).warn = realWarn;
    (ActiveLogger as any).error = realError;
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const host: any = { id: "host" };

  it("does nothing when the stream has no current umid", async () => {
    let walks = 0;
    E.currentUmidFor = async () => undefined;
    E.walkUmidHistory = async () => (walks++, {});
    E.repairHistoryInBackground(host, "s", "#x");
    await settle();
    expect(walks).to.equal(0);
    expect(recorded).to.deep.equal([]);
  });

  it("walks from the current umid, says what it recovered and records an incomplete walk", async () => {
    const walk = { recovered: ["u1", "u2"], complete: false, stoppedAt: "no peer had it", frontier: "u3" };
    let walkedFrom: any[] = [];
    E.currentUmidFor = async () => "adopted-umid";
    E.walkUmidHistory = async (...a: any[]) => ((walkedFrom = a), walk);
    E.repairHistoryInBackground(host, "stream-1", "#2");
    await settle();
    expect(walkedFrom).to.deep.equal([host, "stream-1", "adopted-umid"]);
    expect(warns).to.deep.equal(["SPI WALK #2 stream-1 recovered 2 umid(s), stopped: no peer had it"]);
    expect(recorded).to.deep.equal([[host, "stream-1", walk, "adopted-umid", "#2"]]);
  });

  it("stays quiet about a walk that recovered nothing, but still records it", async () => {
    const walk = { recovered: [], complete: true, stoppedAt: "start of history" };
    E.currentUmidFor = async () => "adopted";
    E.walkUmidHistory = async () => walk;
    E.repairHistoryInBackground(host, "s", "#1");
    await settle();
    expect(warns).to.deep.equal([]);
    expect(recorded).to.have.length(1);
  });

  it("never lets a failure escape, logging it against the stream", async () => {
    E.currentUmidFor = async () => {
      throw new Error("db gone");
    };
    E.repairHistoryInBackground(host, "stream-9", "#1");
    await settle();
    expect(errors).to.have.length(1);
    expect(errors[0][0].message).to.equal("db gone");
    expect(errors[0][1]).to.equal("SPI WALK #1 stream-9 failed");
  });

  it("currentUmidFor reads the umid from the stream's meta, and nothing when it cannot", async () => {
    E.currentUmidFor = realCurrent;
    const got = await E.currentUmidFor({ dbConnection: { get: async (id: string) => ({ umid: id === "s:stream" ? "meta-umid" : "no" }) } }, "s");
    expect(got).to.equal("meta-umid");
    expect(await E.currentUmidFor({ dbConnection: { get: async () => ({}) } }, "s")).to.equal(undefined);
    expect(
      await E.currentUmidFor({ dbConnection: { get: async () => { throw new Error("x"); } } }, "s")
    ).to.equal(undefined);
  });
});

describe("Endpoints.DirectInternalInitalise rebroadcast (cov)", () => {
  const tx = (): any => ({ $umid: "u", $territoriality: "other-node", $tx: {} });
  const hostWith = (knock: (...a: any[]) => Promise<any>) => {
    const asked: string[] = [];
    return {
      asked,
      host: {
        reference: "me",
        terriMap: (t: string) => t,
        neighbourhood: { get: (ref: string) => (asked.push(ref), { knock }) },
      } as any,
    };
  };

  it("hands the transaction to the territorial node and flags the answer as rebroadcast", async () => {
    const knocked: any[][] = [];
    const { host, asked } = hostWith(async (...a: any[]) => (knocked.push(a), { status: 200, data: { ok: 1 } }));
    const t = tx();
    const ledger = await E.DirectInternalInitalise(host, t);
    expect(asked).to.deep.equal(["other-node"]);
    // (endpoint, tx, external, resend, bundle)
    expect(knocked).to.deep.equal([["", t, true, 0, false]]);
    expect(ledger).to.deep.equal({ status: 200, data: { ok: 1 }, rebroadcasted: true });
  });

  it("passes the territorial node's failure back to the caller", async () => {
    const failure = { statusCode: 500, content: "territory down" };
    const { host } = hostWith(async () => {
      throw failure;
    });
    let caught: any;
    await E.DirectInternalInitalise(host, tx()).catch((e: any) => (caught = e));
    expect(caught).to.equal(failure);
  });
});
