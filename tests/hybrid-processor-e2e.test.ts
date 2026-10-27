import { expect } from "chai";
import "mocha";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { ActiveCrypto } from "../packages/crypto/src";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { docHash, verifyContext } from "../packages/hybrid/src/verify";
import { Processor } from "../packages/hybrid/src/processor";
import { SourceLookup } from "../packages/hybrid/src/lookup";

// The processor with its default executor, Process.dryRunHybrid: a committed
// feed item whose supernodes ran the same contract is saved at exactly the
// attested revisions.
describe("Hybrid processor with Process.dryRunHybrid", function () {
  this.timeout(20000);
  const NETWORK = "e2e-network";
  const NS = "hybride2e";
  const S = ActiveCrypto.Hash.getHash("hybrid-e2e-stream");
  const contractsDir = path.join(process.cwd(), "contracts");
  const createdContractsDir = !fs.existsSync(contractsDir);
  const keys = new ActiveCrypto.KeyPair("rsa").generate();
  const node = {
    pair: new ActiveCrypto.KeyPair("rsa", keys.prv.pkcs8pem),
    ref: ActiveCrypto.Hash.getHash("10.0.0.1" + 5260 + NETWORK, "sha1"),
  };
  const setupDoc = {
    _id: NETWORK,
    consensus: { reached: 100 },
    neighbourhood: [{ host: "10.0.0.1", port: 5260, identity: { type: "rsa", public: keys.pub.pkcs8pem } }],
    security: { namespace: {}, signedOutputs: false, hardenedKeys: false },
  };
  let dir: string;
  let store: IEmbeddedStorage;
  let security: any;

  before(() => {
    fs.mkdirSync(path.join(contractsDir, NS), { recursive: true });
    fs.writeFileSync(
      path.join(contractsDir, NS, "e2eplain.js"),
      `const { Event } = require("@activeledger/activecontracts");
      class C extends Event {
        async verify() { return true; }
        async vote() { return true; }
        async commit() {
          const s = this.getActivityStreams("${S}");
          const state = s.getState();
          s.setState({ ...state, count: state.count + 1 });
          this.setContractData({ runs: 1 });
          this.event.emit("counted", { count: state.count + 1 });
        }
      }
      exports.default = C;`
    );
    security = ActiveOptions.get("security", null);
  });
  after(() => {
    ActiveOptions.set("security", security);
    fs.rmSync(createdContractsDir ? contractsDir : path.join(contractsDir, NS), { recursive: true, force: true });
  });
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-e2e-"));
    store = await openEmbeddedStorage(dir);
    await store.data.bulkDocs(
      [
        { _id: S, _rev: "1-state", count: 1 },
        { _id: `${S}:stream`, _rev: "1-meta", umid: "earlier", name: "s" },
      ],
      { new_edits: false }
    );
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  /** What LevelMe stores for a new_edits:true write, as a supernode commit does */
  const storedForm = (doc: any) => {
    const pos = doc._rev ? parseInt(doc._rev, 10) + 1 : 1;
    return { ...doc, _rev: `${pos}-${md5(JSON.stringify({ ...doc, _rev: null }))}` };
  };

  it("executes, saves the outputs at the attested revisions and stores the :umid doc", async () => {
    const umid = "e2e-umid-1";
    const $revs = { $i: {}, $o: { [S]: "1-meta:1-state" } };
    const entry: any = {
      $umid: umid,
      $datetime: "2026-10-23T10:00:00.000Z",
      $origin: "supernode-a",
      $remoteAddr: "127.0.0.1",
      $tx: { $namespace: NS, $contract: "e2eplain", $i: {}, $o: { [S]: {} } },
      $sigs: {},
      $selfsign: false,
      $revs,
    };

    // What the supernode committed: the same execution, stored
    ActiveOptions.set("security", setupDoc.security);
    const reference = await ActiveProtocol.Process.dryRunHybrid(entry, store.data as any);
    expect(reference.committed, reference.error).to.equal(true);
    const signed: any = {};
    for (const id of Object.keys(reference.documents)) signed[id] = storedForm(reference.documents[id]);
    const revsOut: any = {};
    for (const id of Object.keys(signed)) revsOut[id] = { rev: signed[id]._rev, sha256: docHash(signed[id]) };
    const umidDoc = storedForm(reference.umidDoc);
    // Run later than the reference, so its events carry other _id stamps
    await new Promise((r) => setTimeout(r, 5));

    const item: any = {
      umid,
      outcome: "committed",
      umidDoc,
      $revs,
      revsOut,
      nodes: {
        [node.ref]: { vote: true, sig: ActiveCrypto.signDigest(node.pair, ActiveCrypto.voteDigest(umid, true, $revs)) },
      },
    };
    item.attestation = {
      node: node.ref,
      umid,
      outcome: "committed",
      revsOut,
      umidDocHash: docHash(umidDoc),
      sig: ActiveCrypto.signDigest(
        node.pair,
        ActiveCrypto.commitDigest(umid, "committed", $revs, revsOut, docHash(umidDoc))
      ),
    };

    const events: any[] = [];
    const sources = { peers: [], supernodes: [] };
    const processor = new Processor({
      store: store as any,
      sources,
      lookup: new SourceLookup({ store: store as any, sources }),
      events: { emit: async (e) => void events.push(e) },
      context: () => verifyContext(setupDoc, NETWORK),
      setup: () => setupDoc,
      contracts: null,
    });
    const out = await processor.apply(item, {} as any);
    expect(out, out.reasons.join()).to.deep.include({ action: "saved", vote: "yes" });
    for (const id of Object.keys(signed)) {
      expect(await store.data.get(id)).to.deep.equal(signed[id]);
    }
    expect(await store.data.get(`${umid}:umid`)).to.deep.equal(umidDoc);
    expect(events.map((e) => e.type)).to.deep.equal(["counted", "tx.committed"]);
    expect(events[0].payload).to.deep.equal({ count: 2 });
  });
});
