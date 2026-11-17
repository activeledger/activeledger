import { expect } from "chai";
import "mocha";
// By package name: endpoints reads build through the built lib's ActiveOptions
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";

const E: any = Endpoints;

/**
 * Edges a mutation pass over network/endpoints.ts found nothing checking.
 */
describe("Endpoints - edges the tests did not pin (Activeprotocol)", () => {
  describe("verifyRelay: a malformed relay is dropped before the registry is read", () => {
    let savedBuild: any;
    beforeEach(() => {
      savedBuild = ActiveOptions.get("build", 0);
      ActiveOptions.set("build", 40300);
    });
    afterEach(() => ActiveOptions.set("build", savedBuild));

    const cases: [string, any][] = [
      ["none", undefined],
      ["a key that is not a string", { key: 5, sig: "s" }],
      ["a signature that is not a string", { key: "k", sig: 5 }],
      ["an empty key", { key: "", sig: "s" }],
      ["an empty signature", { key: "k", sig: "" }],
    ];
    for (const [name, relay] of cases) {
      it(`drops ${name} without touching the database`, async () => {
        let reads = 0;
        const db: any = {
          exists: async () => (reads++, false),
          get: async () => (reads++, {}),
        };
        expect(await Endpoints.verifyRelay(db, relay, "u")).to.equal(undefined);
        expect(reads).to.equal(0);
      });
    }
  });

  describe("a transaction expiring at this very moment has expired", () => {
    const RealDate = Date;
    const T = new RealDate("2030-01-01T00:00:00.000Z").getTime();
    afterEach(() => {
      (global as any).Date = RealDate;
    });

    it("is refused when $expire equals the time it is received", async () => {
      class FixedDate extends RealDate {
        constructor(...a: any[]) {
          if (a.length) super(...(a as [any]));
          else super(T);
        }
      }
      (global as any).Date = FixedDate;
      const reply = await Endpoints.ExternalInitalise(
        {} as any,
        {
          $tx: {
            $namespace: "default",
            $contract: "contract-id",
            $i: { signer: { publicKey: "k" } },
            $expire: new RealDate(T).toISOString(),
          },
          $sigs: { signer: "sig" },
        },
        "1.2.3.4",
        {} as any
      );
      expect(reply.content.$summary.errors[0]).to.match(/^Transaction Expired/);
    });
  });

  describe("asking the network for a umid", () => {
    it("asks every neighbour, and reports whether this node now holds the umid", async () => {
      const asked: any[] = [];
      const host: any = {
        resentAs: async () => undefined, rememberResent: () => undefined,
        dbConnection: { get: async (id: string) => ({ _id: id }) },
        dbEventConnection: { post: async () => undefined, get: async () => ({}) },
        neighbourhood: { knockAll: async (...a: any[]) => (asked.push(a), []) },
      };
      expect(await Endpoints.backfillUmid(host, "held-umid")).to.equal(true);
      await E.syncContext(host).peers.umid("U1");
      expect(asked).to.deep.equal([["umid/U1", null, true]]);
    });
  });

  describe("history repair after a commit", () => {
    const STREAM = "a".repeat(64);
    beforeEach(() => {
      E.historyRepairLastRun.clear();
      E.historyRepairInFlight.clear();
    });
    afterEach(() => {
      E.historyRepairLastRun.clear();
      E.historyRepairInFlight.clear();
    });

    const hostFor = (majority: any[], get?: (id: string) => any) => {
      const knocks: any[] = [];
      return {
        knocks,
        host: {
          dbConnection: {
            get:
              get ||
              (async () => {
                throw new Error("missing");
              }),
          },
          neighbourhood: { knockAll: async (...a: any[]) => (knocks.push(a), majority) },
        } as any,
      };
    };

    it("always hands back a promise, even when it has nothing to do", async () => {
      const { host } = hostFor([]);
      expect(E.repairHistoryAfterCommit(host, "")).to.be.instanceOf(Promise);
      expect(E.repairHistoryAfterCommit(host, "u", [])).to.be.instanceOf(Promise);
      E.historyRepairInFlight.add("busy");
      expect(E.repairHistoryAfterCommit(host, "busy", [STREAM])).to.be.instanceOf(Promise);
    });

    it("asks every neighbour which transaction came before", async () => {
      const { host, knocks } = hostFor([]);
      await E.repairHistoryAfterCommit(host, "u-all", [STREAM]);
      expect(knocks).to.deep.equal([["umid/u-all", null, true]]);
    });

    it("looks again for a stream exactly one cooldown after the last look", async () => {
      const realNow = Date.now;
      const T = 1_000_000_000_000;
      Date.now = () => T;
      try {
        E.historyRepairLastRun.set(STREAM, T - E.HISTORY_REPAIR_COOLDOWN_MS);
        const { host, knocks } = hostFor([]);
        await E.repairHistoryAfterCommit(host, "u-due", [STREAM]);
        expect(knocks).to.have.length(1);
        E.historyRepairLastRun.set(STREAM, T - E.HISTORY_REPAIR_COOLDOWN_MS + 1);
        await E.repairHistoryAfterCommit(host, "u-not-due", [STREAM]);
        expect(knocks).to.have.length(1);
      } finally {
        Date.now = realNow;
      }
    });

    it("goes on to the next answer when one has no streams", async () => {
      const walked: any[] = [];
      const realWalk = E.walkUmidHistory;
      E.walkUmidHistory = async (_h: any, s: string, p: string) => {
        walked.push([s, p]);
        return { recovered: [], complete: true, stoppedAt: "x" };
      };
      try {
        // answers are read from the last to the first: the empty one comes first
        const good = { streams: { updated: [{ id: STREAM, prev: "p1" }] } };
        const { host } = hostFor([good, {}]);
        await E.repairHistoryAfterCommit(host, "u-skip", [STREAM]);
        expect(walked).to.deep.equal([[STREAM, "p1"]]);
      } finally {
        E.walkUmidHistory = realWalk;
      }
    });

    it("walks behind a stream whose previous umid read back with no id", async () => {
      const walked: any[] = [];
      const realWalk = E.walkUmidHistory;
      E.walkUmidHistory = async (_h: any, s: string, p: string) => {
        walked.push([s, p]);
        return { recovered: [], complete: true, stoppedAt: "x" };
      };
      try {
        const doc = { streams: { updated: [{ id: STREAM, prev: "p2" }] } };
        const { host } = hostFor([doc], async () => ({}));
        await E.repairHistoryAfterCommit(host, "u-noid", [STREAM]);
        expect(walked).to.deep.equal([[STREAM, "p2"]]);
      } finally {
        E.walkUmidHistory = realWalk;
      }
    });
  });

  describe("recording a walk that stopped early", () => {
    it("leaves a 950 record that asks the network, naming the umid it got stuck on", async () => {
      const posted: any[] = [];
      const host: any = { dbErrorConnection: { post: async (d: any) => posted.push(d) } };
      await E.recordIncompleteWalk(host, "s", { complete: false, frontier: "F1", stoppedAt: "no node could supply it" }, "start", "#t");
      expect(posted).to.have.length(1);
      expect(posted[0].code).to.equal(950);
      expect(posted[0].umid).to.equal("F1");
      expect(posted[0].processed).to.equal(false);
      expect(posted[0].transaction.$broadcast).to.equal(true);
    });
  });

  describe("the memory of when streams were last checked", () => {
    afterEach(() => E.historyRepairLastRun.clear());

    it("is swept as soon as it reaches 1000 entries", () => {
      E.historyRepairLastRun.clear();
      for (let i = 0; i < 1000; i++) E.historyRepairLastRun.set(`old-${i}`, 1);
      E.pruneHistoryRepairMemory();
      expect(E.historyRepairLastRun.size).to.equal(0);
    });

    it("keeps an entry made exactly one cooldown ago", () => {
      const realNow = Date.now;
      const T = 1_000_000_000_000;
      Date.now = () => T;
      try {
        E.historyRepairLastRun.clear();
        for (let i = 0; i < 1000; i++) E.historyRepairLastRun.set(`old-${i}`, 1);
        E.historyRepairLastRun.set("edge", T - E.HISTORY_REPAIR_COOLDOWN_MS);
        E.pruneHistoryRepairMemory();
        expect([...E.historyRepairLastRun.keys()]).to.deep.equal(["edge"]);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("an inbound message that is marked encrypted", () => {
    const realRef = Home.reference;
    afterEach(() => {
      Home.reference = realRef;
    });

    it("is decrypted even when it looks like plain JSON", async () => {
      let decrypted = 0;
      const host: any = {
        resentAs: async () => undefined, rememberResent: () => undefined,
        reference: "me",
        decrypt: (b: string) => (decrypted++, Buffer.from(JSON.stringify({ a: 1 })).toString("base64")),
        neighbourhood: { get: () => ({}) },
      };
      await Endpoints.postConvertor(host, '{"cipher":"text"}', true).catch(() => undefined);
      expect(decrypted).to.equal(1);
    });

    it("is parsed straight away, without decrypting, when it is plain JSON", async () => {
      let decrypted = 0;
      const host: any = { reference: "me", decrypt: () => (decrypted++, ""), neighbourhood: { get: () => ({}) } };
      const out = await Endpoints.postConvertor(host, '{"a":1}', false);
      expect(decrypted).to.equal(0);
      expect(out.body).to.deep.equal({ a: 1 });
    });
  });

  describe("origin repair of a stream position error: when to ask the network", () => {
    const realRef = Home.reference;
    const realRepair = E.repairHistoryInBackground;
    const SPI = "Stream Position Incorrect";
    let n = 0;

    beforeEach(() => {
      Home.reference = "me";
      ActiveOptions.set("consensus", { reached: 66 });
      E.repairHistoryInBackground = () => undefined;
    });
    afterEach(() => {
      Home.reference = realRef;
      ActiveOptions.set("consensus", undefined);
      E.repairHistoryInBackground = realRepair;
    });

    const run = async (nodes: any, answers: (id: string) => any[], read?: (id: string) => any) => {
      const streamId = `${++n}`.padStart(64, "d");
      const written: any[] = [];
      let asked = 0;
      let calls = 0;
      const host: any = {
        resentAs: async () => undefined, rememberResent: () => undefined,
        reference: "me",
        pending: () =>
          Promise.resolve(
            ++calls === 1
              ? {
                  status: 200,
                  data: {
                    $umid: "first",
                    $tx: { $contract: "c".repeat(64), $i: { [streamId]: {} }, $o: {} },
                    $nodes: nodes,
                  },
                }
              : { status: 200, data: { $umid: "second", $nodes: { me: { vote: true, commit: true } } } }
          ),
        release: () => undefined,
        neighbourhood: { count: () => 4, knockAll: async () => (asked++, answers(streamId)) },
        dbConnection: {
          get: async () => (read ? read(streamId) : { _id: streamId, _rev: "1-stale" }),
          bulkDocs: async (docs: any[], opts: any) => (written.push({ docs, opts }), { ok: true }),
        },
      };
      await Endpoints.ExternalInitalise(
        host,
        {
          $tx: { $namespace: "default", $contract: "c".repeat(64), $i: { signer: {} } },
          $sigs: { signer: "s" },
        },
        "1.2.3.4",
        { exists: async () => false } as any
      );
      return { written, asked: () => asked };
    };

    const bad = { vote: false, commit: false, error: SPI };

    it("acts when exactly as many nodes answer as consensus needs", async () => {
      const r = await run({ me: bad, b: bad, c: bad }, (id) => {
        const w = { _id: id, _rev: "2-winner" };
        return [[w], [w]];
      });
      expect(r.written).to.have.length(1);
    });

    it("leaves the document alone, and does not crash, when the data engine answered nothing", async () => {
      const r = await run({ me: bad, b: bad, c: bad }, (id) => [[{ _id: id, _rev: "2-w" }], [{ _id: id, _rev: "2-w" }]], () => null);
      expect(r.written).to.have.length(0);
    });

    it("does not look for a repair once any node has committed", async () => {
      const r = await run({ me: bad, b: bad, c: { vote: true, commit: true } }, (id) => [[{ _id: id, _rev: "2-w" }]]);
      expect(r.asked()).to.equal(0);
      expect(r.written).to.have.length(0);
    });

    it("does not look for a repair when only one node took part", async () => {
      const r = await run({ me: bad }, (id) => [[{ _id: id, _rev: "2-w" }]]);
      expect(r.asked()).to.equal(0);
    });
  });
});
