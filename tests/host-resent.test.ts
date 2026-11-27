import { expect } from "chai";
import "mocha";
import { createHash } from "crypto";
import { Host } from "../packages/network/src/network/host";
import { Endpoints } from "../packages/network/src/network/endpoints";

const E: any = Endpoints;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const UMID = "a".repeat(64);
const NEW = "b".repeat(64);

/**
 * A transaction the entry node resent under a new umid was never stored under
 * the old one, so the same signed bytes reposted before their $expire ran
 * again. These pin how the node now remembers the umid it gave up.
 */
describe("Host - a transaction resent under a new umid (Activenetwork)", () => {
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  let timers: { fn: () => void; ms: number }[];

  beforeEach(() => {
    timers = [];
    (global as any).setTimeout = (fn: () => void, ms: number) => (timers.push({ fn, ms }), { unref() {} } as any);
    (global as any).setInterval = () => ({ unref() {} } as any);
  });
  afterEach(() => {
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
  });

  /** A host without its constructor, with an events database that records what it is asked */
  const makeHost = (over: any = {}) => {
    const posted: any[] = [];
    const reads: string[] = [];
    const purged: any[] = [];
    const rows: Record<string, any> = over.rows ?? {};
    const host: any = Object.create(Host.prototype);
    Object.assign(host, {
      resentGuardUntil: 0,
      resentInFlight: new Map(),
      dbEventConnection: {
        post: async (doc: any) => {
          if (over.postFails) throw new Error("disk full");
          posted.push(doc);
          rows[doc._id] = doc;
          return { ok: true };
        },
        get: async (id: string) => {
          reads.push(id);
          if (over.getFails) throw new Error("down");
          return rows[id] ?? { error: "not_found" };
        },
        // as the real storage answers include_docs: each row is the document itself
        allDocs: async () => (over.listFails ? undefined : { total_rows: Object.keys(rows).length, rows: Object.values(rows) }),
        purge: async (doc: any) => (purged.push(doc._id), delete rows[doc._id]),
      },
    });
    return { host, posted, reads, purged, rows };
  };
  const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
  const settle = () => new Promise((r) => setImmediate(r));

  describe("rememberResent", () => {
    it("records the umid it gave up, with the one it resent under and when the transaction expires", async () => {
      const { host, posted } = makeHost();
      const expire = inAnHour();
      host.rememberResent(UMID, NEW, expire);
      await settle();
      expect(posted).to.deep.equal([{ _id: `resent:${UMID}`, to: NEW, until: new Date(expire).getTime() }]);
    });

    it("writes the row once when it is noted twice, as the entry node does when it resends and again when it commits", async () => {
      const { host, posted } = makeHost();
      const expire = inAnHour();
      host.rememberResent(UMID, NEW, expire);
      await settle();
      host.rememberResent(UMID, NEW, expire);
      await settle();
      expect(posted).to.have.length(1);
    });

    it("records nothing for a transaction with no $expire, whose bytes can never make the same umid again", () => {
      const { host, posted } = makeHost();
      host.rememberResent(UMID, NEW, undefined);
      host.rememberResent(UMID, NEW, "");
      expect(posted).to.have.length(0);
      expect(host.resentGuardUntil).to.equal(0);
    });

    it("records nothing for one that has already expired, or whose $expire is not a date", () => {
      const { host, posted } = makeHost();
      host.rememberResent(UMID, NEW, new Date(Date.now() - 1000).toISOString());
      host.rememberResent(UMID, NEW, "not a date");
      expect(posted).to.have.length(0);
      expect(host.resentGuardUntil).to.equal(0);
    });

    it("keeps the guard at the latest $expire of any transaction resent", () => {
      const { host } = makeHost();
      const soon = new Date(Date.now() + 1000).toISOString();
      const later = new Date(Date.now() + 9000).toISOString();
      host.rememberResent(UMID, NEW, later);
      host.rememberResent("c".repeat(64), "d".repeat(64), soon);
      expect(host.resentGuardUntil).to.equal(new Date(later).getTime());
    });

    it("holds nothing in memory once the row is written", async () => {
      const { host } = makeHost();
      host.rememberResent(UMID, NEW, inAnHour());
      expect(host.resentInFlight.size).to.equal(1);
      await settle();
      expect(host.resentInFlight.size).to.equal(0);
    });

    it("keeps it in memory, until the transaction expires, if the row could not be written", async () => {
      const { host } = makeHost({ postFails: true });
      host.rememberResent(UMID, NEW, new Date(Date.now() + 5000).toISOString());
      await settle();
      expect(host.resentInFlight.get(UMID)).to.equal(NEW);
      const drop = timers[timers.length - 1];
      expect(drop.ms).to.be.greaterThan(0).and.at.most(5000);
      drop.fn();
      expect(host.resentInFlight.size).to.equal(0);
    });
  });

  describe("resentAs", () => {
    it("answers at once, without reading anything, when nothing has been resent", async () => {
      const { host, reads } = makeHost();
      expect(await host.resentAs(UMID)).to.equal(undefined);
      expect(reads).to.have.length(0);
    });

    it("answers from memory in the instant after a resend, before the row is there", async () => {
      const { host, reads } = makeHost();
      host.rememberResent(UMID, NEW, inAnHour());
      expect(await host.resentAs(UMID)).to.equal(NEW);
      expect(reads).to.have.length(0);
    });

    it("reads the row for a transaction while the guard is up, and answers with where it was resent", async () => {
      const { host, reads } = makeHost({ rows: { [`resent:${UMID}`]: { _id: `resent:${UMID}`, to: NEW, until: Date.now() + 1000 } } });
      host.resentGuardUntil = Date.now() + 1000;
      expect(await host.resentAs(UMID)).to.equal(NEW);
      expect(reads).to.deep.equal([`resent:${UMID}`]);
    });

    it("says nothing for a transaction that was not resent", async () => {
      const { host } = makeHost();
      host.resentGuardUntil = Date.now() + 1000;
      expect(await host.resentAs(UMID)).to.equal(undefined);
    });

    it("says nothing for a row whose transaction has expired", async () => {
      const { host } = makeHost({ rows: { [`resent:${UMID}`]: { to: NEW, until: Date.now() - 1 } } });
      host.resentGuardUntil = Date.now() + 1000;
      expect(await host.resentAs(UMID)).to.equal(undefined);
    });

    it("treats an answer that is not a row as a definite 'not resent'", async () => {
      for (const answer of [{}, { error: "not_found" }]) {
        const { host } = makeHost();
        host.dbEventConnection.get = async () => answer;
        host.resentGuardUntil = Date.now() + 1000;
        expect(await host.resentAs(UMID), JSON.stringify(answer)).to.equal(undefined);
      }
    });

    it("refuses to answer, instead of saying 'not resent', when the events database gives no answer while a resend is live", async () => {
      for (const failure of ["throws", "null", "undefined"]) {
        const { host } = makeHost();
        host.dbEventConnection.get = async () => {
          if (failure === "throws") throw new Error("down");
          return failure === "null" ? null : undefined;
        };
        host.resentGuardUntil = Date.now() + 1000;
        let refused = false;
        await host.resentAs(UMID).catch(() => (refused = true));
        expect(refused, failure).to.equal(true);
      }
    });

    it("does not need the events database, and so cannot fail on it, when nothing has been resent", async () => {
      const { host } = makeHost({ getFails: true });
      expect(await host.resentAs(UMID)).to.equal(undefined);
    });

    it("stops looking once the guard has passed", async () => {
      const { host, reads } = makeHost();
      host.resentGuardUntil = Date.now() - 1;
      expect(await host.resentAs(UMID)).to.equal(undefined);
      expect(reads).to.have.length(0);
    });
  });

  describe("refreshResentGuard (at start, and hourly)", () => {
    it("puts the guard at the latest $expire among the rows, and removes the rows that have expired", async () => {
      const live = Date.now() + 60_000;
      const { host, purged } = makeHost({
        rows: {
          "resent:1": { _id: "resent:1", to: "x", until: live },
          "resent:2": { _id: "resent:2", to: "x", until: live - 30_000 },
          "resent:3": { _id: "resent:3", to: "x", until: Date.now() - 5000 },
        },
      });
      await host.refreshResentGuard();
      expect(host.resentGuardUntil).to.equal(live);
      expect(purged).to.deep.equal(["resent:3"]);
    });

    it("leaves the guard at zero when there is nothing live, so a normal node never looks anything up", async () => {
      const { host } = makeHost();
      host.resentGuardUntil = Date.now() - 10;
      await host.refreshResentGuard();
      expect(host.resentGuardUntil).to.equal(0);
    });

    it("tries again in 30 seconds when the events database does not answer, and keeps the guard it had", async () => {
      const { host } = makeHost({ listFails: true });
      host.resentGuardUntil = 12345;
      expect(await host.refreshResentGuard()).to.equal(false);
      expect(host.resentGuardUntil).to.equal(12345);
      expect(timers[timers.length - 1].ms).to.equal(30_000);
    });

    it("leaves the retrying to its caller when asked, and says it read the list when it did", async () => {
      const failing = makeHost({ listFails: true });
      expect(await failing.host.refreshResentGuard(false)).to.equal(false);
      expect(timers).to.have.length(0);
      const working = makeHost();
      expect(await working.host.refreshResentGuard(false)).to.equal(true);
      expect(working.host.resentLoaded).to.equal(true);
    });

    it("does not lower the guard under a transaction that was only just resent", async () => {
      const { host } = makeHost();
      const expire = inAnHour();
      host.rememberResent(UMID, NEW, expire);
      await host.refreshResentGuard();
      expect(host.resentGuardUntil).to.equal(new Date(expire).getTime());
    });
  });

  describe("after a start (the storage may come up after the host)", () => {
    it("reads the list once, and starts no timer and no loop when the storage does not answer", async () => {
      const { host } = makeHost({ listFails: true });
      await host.loadResentGuard();
      expect(timers).to.have.length(0);
      expect(!!host.resentLoaded).to.equal(false);
    });

    it("makes a lookup wait for the list rather than answer 'not resent' too soon", async () => {
      const { host } = makeHost({ rows: { [`resent:${UMID}`]: { _id: `resent:${UMID}`, to: NEW, until: Date.now() + 60_000 } } });
      let finish!: () => void;
      host.resentLoading = new Promise<void>((r) => (finish = r));
      host.resentLoaded = false;
      let answer: string | undefined = "not yet";
      const asked = host.resentAs(UMID).then((a: string | undefined) => (answer = a));
      await settle();
      expect(answer).to.equal("not yet");
      host.resentGuardUntil = Date.now() + 60_000;
      host.resentLoaded = true;
      finish();
      await asked;
      expect(answer).to.equal(NEW);
    });

    it("tries again every half second while a transaction waits, and goes on once the storage answers", async () => {
      const { host } = makeHost({ rows: { [`resent:${UMID}`]: { _id: `resent:${UMID}`, to: NEW, until: Date.now() + 60_000 } } });
      const real = host.dbEventConnection.allDocs;
      let calls = 0;
      host.dbEventConnection.allDocs = async (o: any) => (++calls < 3 ? undefined : real(o));
      await host.loadResentGuard();
      let answer: string | undefined;
      const asked = host.resentAs(UMID).then((a: string | undefined) => (answer = a));
      for (let i = 0; i < 2; i++) {
        await settle();
        expect(timers[timers.length - 1].ms).to.equal(500);
        timers[timers.length - 1].fn();
      }
      await asked;
      expect(answer).to.equal(NEW);
      expect(calls).to.equal(3);
    });

    it("gives up after five seconds of trying and refuses to answer", async () => {
      const { host } = makeHost({ listFails: true });
      await host.loadResentGuard();
      let refused = false;
      const asked = host.resentAs(UMID).catch(() => (refused = true));
      for (let i = 0; i < 10; i++) {
        await settle();
        timers[timers.length - 1].fn();
      }
      await asked;
      expect(refused).to.equal(true);
      expect(timers.filter((t) => t.ms === 500)).to.have.length(10);
    });

    it("shares the waiting between requests that arrive together", async () => {
      const { host } = makeHost({ listFails: true });
      await host.loadResentGuard();
      const asks = [1, 2, 3].map(() => host.resentAs(UMID).catch(() => "refused"));
      await settle();
      expect(timers.filter((t) => t.ms === 500)).to.have.length(1);
      for (let i = 0; i < 10; i++) {
        await settle();
        timers[timers.length - 1].fn();
      }
      expect(await Promise.all(asks)).to.deep.equal(["refused", "refused", "refused"]);
    });

    it("does not wait once the list has been read", async () => {
      const { host } = makeHost();
      host.resentLoaded = true;
      host.resentLoading = new Promise<void>(() => undefined);
      expect(await host.resentAs(UMID)).to.equal(undefined);
    });
  });

  describe("the check on a transaction that comes in with an $expire", () => {
    const body = (expire: string) => ({
      $tx: { $namespace: "default", $contract: "c".repeat(64), $i: { signer: { publicKey: "k" } }, $expire: expire },
      $sigs: { signer: "sig" },
    });

    it("refuses the bytes of a transaction that was resent, and says where it went", async () => {
      const expire = inAnHour();
      const asked: string[] = [];
      const host: any = { resentAs: async (u: string) => (asked.push(u), NEW), mayBeStored: () => true };
      const reply = await Endpoints.ExternalInitalise(host, body(expire), "1.2.3.4", { exists: async () => false } as any);
      expect(asked).to.have.length(1);
      expect(reply.content.$summary.errors[0]).to.equal(`Transaction Exists : ${asked[0]} (resent as ${NEW})`);
      expect(reply.content.$summary.commit).to.equal(0);
    });

    it("is asked for the umid the body makes, the same one the node assigns", async () => {
      const expire = inAnHour();
      const asked: string[] = [];
      const host: any = { resentAs: async (u: string) => (asked.push(u), NEW), mayBeStored: () => true };
      await Endpoints.ExternalInitalise(host, body(expire), "1.2.3.4", { exists: async () => false } as any);
      const sent: any = body(expire);
      expect(asked[0]).to.equal(sha(JSON.stringify(sent)));
    });

    it("tells the client to try again, and goes no further, when it cannot be checked whether it was resent", async () => {
      let existsCalls = 0;
      const host: any = {
        resentAs: async () => {
          throw new Error("could not check");
        },
      };
      const reply = await Endpoints.ExternalInitalise(host, body(inAnHour()), "1.2.3.4", { exists: async () => (existsCalls++, false) } as any);
      expect(reply.content.$summary.errors[0]).to.match(/^Could not check whether [0-9a-f]{64} was already accepted, try again shortly$/);
      expect(reply.content.$summary.commit).to.equal(0);
      expect(existsCalls).to.equal(0);
    });

    it("does not ask the storage when this node's memory knows it was not committed", async () => {
      let existsCalls = 0;
      const host: any = { resentAs: async () => undefined, mayBeStored: () => false, reference: "n" };
      // It goes on to process the transaction, which this stub host cannot: only the lookup matters
      await Promise.race([
        Endpoints.ExternalInitalise(host, body(inAnHour()), "1.2.3.4", { exists: async () => (existsCalls++, true) } as any).catch(() => undefined),
        new Promise((r) => realSetTimeout(r, 200)),
      ]);
      expect(existsCalls).to.equal(0);
    });

    it("still refuses one that is stored, as before, when it was not resent", async () => {
      const host: any = { resentAs: async () => undefined, mayBeStored: () => true };
      const reply = await Endpoints.ExternalInitalise(host, body(inAnHour()), "1.2.3.4", { exists: async () => true } as any);
      expect(reply.content.$summary.errors[0]).to.match(/^Transaction Exists : [0-9a-f]{64}$/);
    });
  });

  describe("giving a transaction its new umid", () => {
    it("makes it as it always was, from the transaction with the old umid still in it, and records the old one", () => {
      const remembered: any[] = [];
      const host: any = { rememberResent: (...a: any[]) => remembered.push(a) };
      const expire = inAnHour();
      const initTx: any = { $umid: UMID, $tx: { $expire: expire }, $sigs: { a: "b" } };
      const expected = sha(JSON.stringify(initTx) + 3);
      E.resendUmid(host, initTx, 3);
      expect(initTx.$umid).to.equal(expected);
      expect(remembered).to.deep.equal([[UMID, expected, expire]]);
    });

    it("carries the first id the transaction had, through any number of resends", () => {
      const host: any = { rememberResent: () => undefined };
      const initTx: any = { $umid: UMID, $tx: {} };
      E.resendUmid(host, initTx, 1);
      expect(initTx.$replaces).to.equal(UMID);
      const second = initTx.$umid;
      E.resendUmid(host, initTx, 2);
      expect(initTx.$replaces).to.equal(UMID);
      expect(initTx.$umid).to.not.equal(second);
    });

    it("gives a different umid to each resend", () => {
      const host: any = { rememberResent: () => undefined };
      const initTx: any = { $umid: UMID, $tx: {} };
      const seen = new Set<string>();
      for (let counter = 0; counter < 4; counter++) {
        E.resendUmid(host, initTx, counter);
        seen.add(initTx.$umid);
      }
      expect(seen.size).to.equal(4);
    });
  });
});
