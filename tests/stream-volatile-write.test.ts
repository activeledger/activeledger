import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

// setVolatile() on a stream that already exists used to write nothing when this
// node had no volatile document for it: the volatile had no id, and a volatile
// without an id is never written. It now names the document, and the commit
// reconciles it with what the node holds.
describe("Writing volatile data to an existing stream (Activecontracts, Activeprotocol)", () => {
  const existing = () =>
    new Activity("umid-1", null as any, true, new EventEmitter(), { _id: "s:stream", _rev: "1-a" } as any, { _id: "s", _rev: "1-a" } as any, "localhost:5259");

  describe("setVolatile", () => {
    it("names the document it will write when none was loaded", () => {
      const activity: any = existing();
      activity.setVolatile({ key: "part" });
      expect(activity.volatile._id).to.equal("s:volatile");
      expect(activity.volatile.key).to.equal("part");
      expect(activity.volatile._rev).to.equal(undefined);
      expect(activity.volatileUpdated).to.equal(true);
    });

    it("keeps the id and revision of a volatile it loaded", () => {
      const activity: any = existing();
      activity.volatile = { _id: "s:volatile", _rev: "3-z", old: 1 };
      activity.setVolatile({ key: "part" });
      expect(activity.volatile).to.deep.equal({ _id: "s:volatile", _rev: "3-z", old: 1, key: "part" });
    });
  });

  describe("reconciling it at commit", () => {
    const updater = (docs: any[], stored: { [id: string]: any }, created: string[] = []) => {
      const reads: string[] = [];
      const u: any = Object.create(StreamUpdater.prototype);
      u.docs = docs;
      u.refStreams = { new: created.map((id) => ({ id })), updated: [] };
      u.shared = { filterPrefix: (id: string) => id };
      u.db = { get: async (id: string) => { reads.push(id); if (id in stored) return stored[id]; throw new Error("missing"); } };
      return { u, reads };
    };

    it("merges into the stored document, which it would otherwise be refused against", async () => {
      const { u } = updater([{ _id: "s:volatile", key: "part" }], { "s:volatile": { _id: "s:volatile", _rev: "2-x", old: 1, key: "was" } });
      await u.reconcileVolatile();
      expect(u.docs[0]).to.deep.equal({ _id: "s:volatile", _rev: "2-x", old: 1, key: "part" });
    });

    it("creates it when the node has none", async () => {
      const { u } = updater([{ _id: "s:volatile", key: "part" }], {});
      await u.reconcileVolatile();
      expect(u.docs[0]).to.deep.equal({ _id: "s:volatile", key: "part" });
    });

    it("leaves alone a volatile that carries a revision, and anything that is not volatile", async () => {
      const { u, reads } = updater([{ _id: "s:volatile", _rev: "2-x", key: "part" }, { _id: "s", _rev: "1-a" }], {});
      await u.reconcileVolatile();
      expect(reads).to.deep.equal([]);
      expect(u.docs[0]).to.deep.equal({ _id: "s:volatile", _rev: "2-x", key: "part" });
    });

    it("does not read for a stream made in this transaction", async () => {
      const { u, reads } = updater([{ _id: "n:volatile", key: "part" }], {}, ["n"]);
      await u.reconcileVolatile();
      expect(reads).to.deep.equal([]);
    });
  });
});
