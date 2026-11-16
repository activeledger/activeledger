import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

/**
 * Edges a mutation pass over Host.pending() found nothing checking: when an
 * internal broadcast is answered at once, when a finished internal
 * transaction is let go, and the vote written for a transaction that already
 * exists.
 */
describe("Host.pending - edges the tests did not pin (Activenetwork)", () => {
  const bare = (extra: any = {}): any =>
    Object.assign(Object.create(Host.prototype), {
      reference: "me",
      host: "1.1.1.1:5260",
      processPending: {},
      processQueue: () => undefined,
      dbConnection: { exists: async () => false },
      ...extra,
    });
  const tx = (over: any = {}): any => ({ $umid: "u1", $tx: { $contract: "c" }, ...over });
  const settled = (p: Promise<any>) =>
    Promise.race([p.then((v) => ({ done: true, v })), new Promise((r) => setTimeout(() => r({ done: false }), 40))]);

  describe("answering at once", () => {
    it("answers an internal broadcast of a new transaction straight away, and marks it answered", async () => {
      const host = bare();
      const r: any = await settled(host.pending(tx({ $broadcast: true }), "2.2.2.2:5260", true));
      expect(r.done).to.equal(true);
      expect(r.v).to.deep.equal({ status: 200, data: { ok: true }, dontRelease: true });
      expect(host.processPending.u1.responded).to.equal(true);
    });

    it("holds the answer for anything else: an external broadcast, or an internal transaction that is not one", async () => {
      const external = bare();
      expect((await settled(external.pending(tx({ $broadcast: true }), "2.2.2.2:5260", false)) as any).done).to.equal(false);
      expect(external.processPending.u1.responded).to.equal(false);
      const plain = bare();
      expect((await settled(plain.pending(tx(), "2.2.2.2:5260", true)) as any).done).to.equal(false);
      expect(plain.processPending.u1.responded).to.equal(false);
    });
  });

  describe("letting go of a finished internal transaction", () => {
    const released = () => {
      const calls: string[] = [];
      return { calls, release: (u: string) => calls.push(u) };
    };

    it("releases it when it answers after it was already answered", async () => {
      const r = released();
      const host = bare({ release: r.release });
      await host.pending(tx({ $broadcast: true }), "2.2.2.2:5260", true);
      host.processPending.u1.resolve({ status: 200, data: {} });
      expect(r.calls).to.deep.equal(["u1"]);
    });

    it("remembers that it answered, so the next answer lets it go", async () => {
      const r = released();
      const host = bare({ release: r.release });
      void host.pending(tx(), "2.2.2.2:5260", true);
      host.processPending.u1.resolve({ status: 200, data: {} });
      expect(host.processPending.u1.responded).to.equal(true);
      expect(r.calls).to.deep.equal([]);
      host.processPending.u1.resolve({ status: 200, data: {} });
      expect(r.calls).to.deep.equal(["u1"]);
    });

    it("counts a refusal as an answer, so a later answer lets it go", async () => {
      const r = released();
      const host = bare({ release: r.release });
      const refused = host.pending(tx(), "2.2.2.2:5260", true).then(() => "answered", (e: any) => e.message);
      host.processPending.u1.reject(new Error("refused"));
      expect(await refused).to.equal("refused");
      expect(host.processPending.u1.responded).to.equal(true);
      expect(r.calls).to.deep.equal([]);
      host.processPending.u1.resolve({ status: 200, data: {} });
      expect(r.calls).to.deep.equal(["u1"]);
    });

    it("does not release a transaction that has not been answered yet, or one that is not internal", async () => {
      const first = released();
      const internal = bare({ release: first.release });
      void internal.pending(tx(), "2.2.2.2:5260", true);
      internal.processPending.u1.resolve({ status: 200, data: {} });
      expect(first.calls).to.deep.equal([]);

      const second = released();
      const external = bare({ release: second.release });
      void external.pending(tx(), "2.2.2.2:5260", false);
      external.processPending.u1.resolve({ status: 200, data: {} });
      external.processPending.u1.resolve({ status: 200, data: {} });
      expect(second.calls).to.deep.equal([]);
    });
  });

  describe("a transaction that already exists", () => {
    const expired = (over: any = {}) => tx({ $tx: { $contract: "c", $expire: "2030-01-01T00:00:00.000Z" }, ...over });
    const exists = () => ({ dbConnection: { exists: async () => true } });

    it("is voted down and not committed, adding this node to the votes it already has", async () => {
      const host = bare(exists());
      const r = await host.pending(expired({ $nodes: { other: { vote: true, commit: true } } }), "2.2.2.2:5260", false);
      expect(r.data.$nodes.other).to.deep.equal({ vote: true, commit: true });
      expect(r.data.$nodes.me).to.deep.equal({ vote: false, commit: false, error: "Transaction Exists : u1" });
    });

    it("is voted down and not committed when it had no votes at all", async () => {
      const host = bare(exists());
      const r = await host.pending(expired(), "2.2.2.2:5260", false);
      expect(r.data.$nodes).to.deep.equal({ me: { vote: false, commit: false, error: "Transaction Exists : u1" } });
    });

    it("is not looked up for the node that already checked it", async () => {
      let looked = 0;
      const host = bare({ dbConnection: { exists: async () => (looked++, true) } });
      void host.pending(expired(), "1.1.1.1:5260", false);
      await new Promise((r) => setTimeout(r, 20));
      expect(looked).to.equal(0);
    });
  });
});
