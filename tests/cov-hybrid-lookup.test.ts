import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { SourceLookup } from "../packages/hybrid/src/lookup";

describe("Hybrid lookup, answers that disagree with the request (cov)", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let warns: string[];
  const origWarn = (ActiveLogger as any).warn;
  const held = async (id: string) => {
    const d = await store.data.get(id);
    return d && d._id ? d : undefined;
  };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-lookup-cov-"));
    store = await openEmbeddedStorage(dir);
    warns = [];
    (ActiveLogger as any).warn = (m: string) => warns.push(String(m));
  });
  afterEach(async () => {
    (ActiveLogger as any).warn = origWarn;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // An upstream that serves what it has whatever revision is asked for
  const stubborn = (docs: any[]) => ({ id: "sn", streams: async () => ({ docs, missing: [] }) });
  const lookup = (up: any) => new SourceLookup({ store: store as any, sources: { peers: [], supernodes: [up] } });

  it("does not take a state at a different revision than the one asked for", async () => {
    const r = await lookup(stubborn([{ _id: "st", _rev: "8-other", v: 1 }])).ensure([{ id: "st", rev: "3-m:7-net" }]);
    expect(r.missing).to.deep.equal(["st"]);
    expect(await held("st")).to.equal(undefined);
    expect(warns).to.deep.equal(["Lookup: sn st: revision 8-other, wanted 7-net"]);
  });
  it("does not take a state whose meta is at a different revision than the one asked for", async () => {
    const r = await lookup(
      stubborn([
        { _id: "st", _rev: "7-net", v: 1 },
        { _id: "st:stream", _rev: "4-meta" },
      ])
    ).ensure([{ id: "st", rev: "3-meta:7-net" }]);
    expect(r.missing).to.deep.equal(["st"]);
    expect(await held("st")).to.equal(undefined);
    expect(await held("st:stream")).to.equal(undefined);
    expect(warns).to.deep.equal(["Lookup: sn st: meta revision 4-meta, wanted 3-meta"]);
  });
  it("does not take a state whose meta is missing when one was asked for", async () => {
    const r = await lookup(stubborn([{ _id: "st", _rev: "7-net" }])).ensure([{ id: "st", rev: "3-meta:7-net" }]);
    expect(r.missing).to.deep.equal(["st"]);
    expect(warns).to.deep.equal(["Lookup: sn st: meta revision undefined, wanted 3-meta"]);
  });
  it("takes both when everything agrees, meta and state", async () => {
    const r = await lookup(
      stubborn([
        { _id: "st", _rev: "7-net", v: 1 },
        { _id: "st:stream", _rev: "3-meta" },
      ])
    ).ensure([{ id: "st", rev: "3-meta:7-net" }]);
    expect(r.missing).to.deep.equal([]);
    expect((await held("st"))._rev).to.equal("7-net");
    expect((await held("st:stream"))._rev).to.equal("3-meta");
    expect(warns).to.deep.equal([]);
  });
});
