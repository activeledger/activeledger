import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "../packages/crypto/src";
import { LevelMe } from "../packages/storage/src/levelme";
import { Attestation } from "../packages/protocol/src/protocol/attest";

describe("Bulk writes answer with the revisions they assigned (Activestorage)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-revs-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const open = () => new LevelMe(dir + path.sep, `b${++n}`, "level", true);
  const opts = { new_edits: true };

  it("gives the revision a read returns, for a new document and for an update", async () => {
    const db = open();
    const first = await db.bulkDocsRevs([{ _id: "a", v: 1 }, { _id: "b", v: 1 }] as any, opts);
    expect(first.ok).to.equal(true);
    expect(first.revs.a).to.equal((await db.get("a"))._rev);
    expect(first.revs.b).to.equal((await db.get("b"))._rev);
    const second = await db.bulkDocsRevs([{ _id: "a", _rev: first.revs.a, v: 2 }] as any, opts);
    expect(second.revs.a).to.match(/^2-/);
    expect(second.revs.a).to.equal((await db.get("a"))._rev);
  });

  it("gives the current revision for content the store already holds", async () => {
    const db = open();
    const first = await db.bulkDocsRevs([{ _id: "a", v: 1 }] as any, opts);
    // _rev last: the store's hash of the content is sensitive to key order
    const again = await db.bulkDocsRevs([{ _id: "a", v: 1, _rev: first.revs.a }] as any, opts);
    expect(again.revs.a).to.equal(first.revs.a);
    expect(again.revs.a).to.equal((await db.get("a"))._rev);
  });

  it("still answers true or false from bulkDocs()", async () => {
    const db = open();
    expect(await db.bulkDocs([{ _id: "a", v: 1 }] as any, opts)).to.equal(true);
  });

  it("lets a commit attest without reading anything back, to what a read would give", async () => {
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
    Attestation.key = new ActiveCrypto.KeyPair("rsa");
    (Attestation.key as any).generate();
    try {
      const db = open();
      // Dates and undefined are what JSON changes on the way to the store
      const sent = () => [
        { _id: "s1", when: new Date(0), gone: undefined, list: [1, { b: undefined, c: "é" }], big: "y".repeat(70000) },
        { _id: "s1:stream", name: "n" },
        { _id: "s1:volatile", v: 1 },
        { _id: "u1:umid", umid: { $umid: "u1" }, streams: { new: [], updated: [] }, events: [] },
      ];
      const entry: any = { $umid: "u1", $revs: {}, $nodes: {} };
      for (const round of [0, 1]) {
        const docs: any[] = sent();
        if (round) for (const d of docs) d._rev = (await db.get(d._id))._rev;
        // What goes over the wire is JSON
        const written = await db.bulkDocsRevs(JSON.parse(JSON.stringify(docs)), opts);
        let reads = 0;
        const counting = { get: async (id: string) => (reads++, db.get(id)) };
        const lazy = await Attestation.facts(counting, entry, docs, written.revs);
        expect(reads, "reads with the revisions known").to.equal(0);
        const readBack = await Attestation.facts(counting, entry, docs);
        expect(lazy, `round ${round}`).to.deep.equal(readBack);
      }
    } finally {
      Attestation.key = undefined;
      ActiveOptions.set("build", 0);
    ActiveOptions.set("hybrid", undefined);
    }
  });
});
