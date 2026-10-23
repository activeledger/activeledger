import { IActiveDSConnect } from "../packages/definitions/lib/definitions";
import { Process } from "../packages/protocol/src/protocol/process";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { checkAdopt } from "../packages/protocol/src/protocol/adopt";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";

// Process in hybrid mode: one local node that votes and commits on its own,
// contracts see isSupernode() false and run in the egress sandbox, and a dry
// run writes nothing while reporting what it would have written.
describe("Process hybrid mode and dry run (Activeprotocol)", () => {
  const NS = "hybriddryrun";
  const dir = path.join(process.cwd(), "contracts", NS);
  const createdContractsDir = !fs.existsSync(path.join(process.cwd(), "contracts"));
  const S = ActiveCrypto.Hash.getHash("hybrid-dry-run-stream");

  const header = `const { Standard } = require("@activeledger/activecontracts");`;
  const contracts: { [name: string]: string } = {
    hyplain: `${header}
      class C extends Standard {
        async verify() { return true; }
        async vote() { return true; }
        async commit() {
          const s = this.getActivityStreams("${S}");
          const state = s.getState();
          s.setState({ ...state, count: state.count + 1 });
          this.setContractData({ runs: 1 });
          this.returnToRemote({ done: true });
        }
      }
      exports.default = C;`,
    hyaware: `${header}
      class C extends Standard {
        async vote() { return true; }
        async commit() {
          const s = this.getActivityStreams("${S}");
          if (this.isSupernode()) {
            s.setState({ ...s.getState(), signature: "signed-on-a-supernode" });
          } else {
            s.adoptFromSupernode({ signature: "string" });
          }
        }
      }
      exports.default = C;`,
    hyegress: `${header}
      class C extends Standard {
        async vote() {
          require("https").request("https://127.0.0.1:1/");
          return true;
        }
        async commit() {}
      }
      exports.default = C;`,
    hyvolatile: `${header}
      class C extends Standard {
        async vote() { return true; }
        async commit() {
          const s = this.getActivityStreams("${S}");
          const v = await s.getVolatile();
          s.setState({ ...s.getState(), seen: v.secret });
        }
      }
      exports.default = C;`,
  };

  let security: any;

  before(() => {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(contracts)) {
      fs.writeFileSync(path.join(dir, `${name}.js`), contracts[name]);
    }
    security = ActiveOptions.get("security", null);
    ActiveOptions.set("security", {
      namespace: {},
      signedOutputs: false,
      hardenedKeys: false,
    });
  });

  after(() => {
    ActiveOptions.set("security", security);
    fs.rmSync(createdContractsDir ? path.join(process.cwd(), "contracts") : dir, {
      recursive: true,
      force: true,
    });
  });

  // A store that serves fixed documents and records every write
  const store = () => {
    const docs: { [id: string]: any } = {
      [S]: { _id: S, _rev: "1-state", count: 1 },
      [`${S}:stream`]: { _id: `${S}:stream`, _rev: "1-meta", umid: "earlier", name: "s" },
      [`${S}:volatile`]: { _id: `${S}:volatile`, _rev: "1-vol", secret: 42 },
    };
    const writes: any[] = [];
    const clone = (d: any) => JSON.parse(JSON.stringify(d));
    const write = async (...d: any[]) => {
      writes.push(...d);
      return { ok: true };
    };
    const db: any = {
      allDocs: async ({ keys }: { keys: string[] }) => ({
        rows: keys.filter((k) => docs[k]).map((k) => ({ doc: clone(docs[k]) })),
      }),
      get: async (id: string) => {
        if (!docs[id]) throw new Error("not found");
        return clone(docs[id]);
      },
      exists: async (id: string) => !!docs[id],
      bulkDocs: (d: any[]) => write(...d),
      post: write,
      put: write,
      purge: write,
    };
    return { db, writes };
  };

  let n = 0;
  const entry = (contract: string, revs: string = "1-meta:1-state"): any => ({
    $umid: `hybrid-dry-run-${contract}-${++n}`,
    $datetime: "2026-10-23T10:00:00.000Z",
    $origin: "supernode-a",
    $tx: { $namespace: NS, $contract: contract, $i: {}, $o: { [S]: {} } },
    $sigs: {},
    $selfsign: false,
    $revs: { $i: {}, $o: { [S]: revs } },
  });

  it("runs verify, vote and commit and reports the documents", async () => {
    const { db, writes } = store();
    const tx = entry("hyplain");
    const result = await Process.dryRunHybrid(tx, db);

    expect(result.error).to.equal(undefined);
    expect(result.vote).to.equal(true);
    expect(result.committed).to.equal(true);
    expect(result.documents[S]).to.include({ count: 2 });
    expect(result.documents[`${S}:stream`].umid).to.equal(tx.$umid);
    expect(result.documents["hyplain:data"]).to.deep.include({ data: { runs: 1 } });
    expect(result.umidDoc._id).to.equal(`${tx.$umid}:umid`);
    expect(result.umidDoc.umid.$revs).to.deep.equal(tx.$revs);
    expect(result.return).to.deep.equal({ done: true });
    expect(result.supernodeDependent).to.equal(false);
    expect(result.dependence).to.deep.equal([]);
    expect(result.adopt).to.deep.equal([]);

    // ...and wrote nothing at all
    expect(writes).to.deep.equal([]);
  });

  it("does not modify the entry it was given", async () => {
    const { db } = store();
    const tx = entry("hyplain");
    const copy = JSON.parse(JSON.stringify(tx));
    await Process.dryRunHybrid(tx, db);
    expect(tx).to.deep.equal(copy);
  });

  it("fails without writing when a stream is not at the item's $revs", async () => {
    const { db, writes } = store();
    const result = await Process.dryRunHybrid(entry("hyplain", "0-old:0-old"), db);

    expect(result.vote).to.equal(false);
    expect(result.committed).to.equal(false);
    expect(result.error).to.match(/Position Incorrect/);
    expect(result.documents).to.deep.equal({});
    expect(writes).to.deep.equal([]);
  });

  it("contracts see isSupernode() false and record their adopt declaration", async () => {
    const { db, writes } = store();
    const result = await Process.dryRunHybrid(entry("hyaware"), db);

    expect(result.committed).to.equal(true);
    expect(result.supernodeDependent).to.equal(true);
    expect(result.dependence).to.deep.equal(["isSupernode"]);
    expect(result.adopt).to.deep.equal([
      { streams: [S], shape: { signature: "string" }, atomic: false, candidates: false },
    ]);
    // The else branch ran: the stream is written, without the signature
    expect(result.documents[S].signature).to.equal(undefined);
    expect(result.documents[S].count).to.equal(1);
    expect(writes).to.deep.equal([]);
  });

  it("its result passes the adopt check against what a supernode signed", async () => {
    const { db } = store();
    const tx = entry("hyaware");
    const result = await Process.dryRunHybrid(tx, db);

    const signed = {
      [S]: { ...result.documents[S], _rev: "2-signed", signature: "signed-on-a-supernode" },
      [`${S}:stream`]: { ...result.documents[`${S}:stream`], _rev: "2-meta" },
    };
    const verdict = checkAdopt({
      umid: tx.$umid,
      signed,
      local: result.documents,
      declarations: result.adopt,
      supernodeDependent: result.supernodeDependent,
    });
    expect(verdict).to.deep.equal({ ok: true, mode: "verified", reasons: [] });

    const tampered = checkAdopt({
      umid: tx.$umid,
      signed: { ...signed, [S]: { ...signed[S], count: 1000 } },
      local: result.documents,
      declarations: result.adopt,
      supernodeDependent: result.supernodeDependent,
    });
    expect(tampered.ok).to.equal(false);
  });

  it("a blocked egress call fails the vote with SupernodeOnly and marks the execution", async () => {
    const { db, writes } = store();
    const result = await Process.dryRunHybrid(entry("hyegress"), db);

    expect(result.vote).to.equal(false);
    expect(result.error).to.match(/https is only available on a supernode/);
    expect(result.supernodeDependent).to.equal(true);
    expect(result.dependence).to.deep.equal(["blocked:https"]);
    expect(writes).to.deep.equal([]);
  });

  it("reading volatile the hybrid does not hold marks the execution", async () => {
    const { db } = store();
    const result = await Process.dryRunHybrid(entry("hyvolatile"), db);

    expect(result.committed).to.equal(true);
    expect(result.dependence).to.deep.equal([`volatile:${S}`]);
  });

  it("reading volatile the hybrid holds does not", async () => {
    const { db } = store();
    const result = await Process.dryRunHybrid(entry("hyvolatile"), db, {
      volatileHeld: (id) => id === S,
    });

    expect(result.committed).to.equal(true);
    expect(result.supernodeDependent).to.equal(false);
    expect(result.documents[S].seen).to.equal(42);
  });

  describe("supernode mode is the default and unchanged", () => {
    const vmscriptPath = "./packages/protocol/src/protocol/vmscript.js";
    const build = (options?: any) => {
      const db = {} as any;
      fs.writeFileSync(vmscriptPath, "{}");
      try {
        return {
          db,
          process: new Process(
            { ...entry("hyplain"), $nodes: { self: {} } },
            "localhost:5259",
            "self",
            { reference: "right", knock: () => new Promise(() => {}) } as any,
            db,
            {} as any,
            {} as any,
            new ActiveCrypto.Secured({} as IActiveDSConnect, [], {}) as any,
            options
          ),
        };
      } finally {
        if (fs.existsSync(vmscriptPath)) fs.unlinkSync(vmscriptPath);
      }
    };

    it("without options it keeps its stores and VM options untouched", () => {
      const { db, process } = build();
      expect((process as any).db).to.equal(db);
      expect((process as any).localOnly).to.equal(false);
      expect((process as any).execution).to.equal(undefined);
    });

    it("mode supernode is the same", () => {
      const { db, process } = build({ mode: "supernode" });
      expect((process as any).db).to.equal(db);
      expect((process as any).localOnly).to.equal(false);
    });

    it("refuses a dry run", async () => {
      const { process } = build();
      let error: any;
      await process.dryRun().catch((e) => (error = e));
      expect(error?.message).to.match(/hybrid mode/);
    });
  });

  describe("the VM passes isSupernode per execution", () => {
    const run = async (execution?: any) => {
      const { db } = store();
      const vm = new VirtualMachine("localhost:5259", {} as any, db, {} as any);
      const umid = `hybrid-vm-${++n}`;
      await vm.initialise(
        {
          contractLocation: path.join(dir, "hyaware.js"),
          umid,
          date: new Date(),
          remoteAddress: "127.0.0.1",
          transaction: { $namespace: NS, $contract: "hyaware", $i: {}, $o: { [S]: {} } } as any,
          signatures: { $sig: "" } as any,
          inputs: [],
          outputs: [
            {
              state: { _id: S, _rev: "1-state", count: 1 },
              meta: { _id: `${S}:stream`, _rev: "1-meta" },
            } as any,
          ],
          readonly: {},
          key: 0,
        },
        "hyaware.js",
        execution
      );
      await vm.commit({} as any, false, umid);
      const out = vm.getActivityStreamsFromVM(umid);
      const report = vm.getExecutionReport(umid);
      vm.destroy(umid);
      return { state: out[0]?.state as any, report };
    };

    it("true with no execution options (supernode as before)", async () => {
      const { state, report } = await run();
      expect(state.signature).to.equal("signed-on-a-supernode");
      expect(report.adopt).to.deep.equal([]);
    });

    it("true for a supernode execution", async () => {
      const { state } = await run({ supernode: true, dryRun: true });
      expect(state.signature).to.equal("signed-on-a-supernode");
    });

    it("false for a hybrid execution", async () => {
      const { state, report } = await run({ supernode: false, dryRun: true });
      expect(state.signature).to.equal(undefined);
      expect(report.adopt).to.have.length(1);
      expect(report.dependence).to.deep.equal(["isSupernode"]);
    });
  });
});
