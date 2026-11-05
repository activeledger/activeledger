import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "../packages/crypto/src";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { bootstrapNode } from "../packages/hybrid/src/bootstrap";

const nodePem = new ActiveCrypto.KeyPair("rsa").generate().pub.pkcs8pem;
const setup = () => ({
  _id: "setup",
  _rev: "3-s",
  neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: nodePem } }],
  consensus: { reached: 60 },
});

describe("bootstrapNode, contract build failures (cov)", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let warns: string[];
  const origWarn = (ActiveLogger as any).warn;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-boot-cov-"));
    store = await openEmbeddedStorage(dir);
    warns = [];
    (ActiveLogger as any).warn = (m: string) => warns.push(String(m));
  });
  afterEach(async () => {
    (ActiveLogger as any).warn = origWarn;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (rebuild: (s: any) => Promise<any>, contracts: string[]) =>
    bootstrapNode({
      upstreams: [{ id: "up", bootstrap: async () => ({ setup: setup(), required: [], contracts, cursor: "c", minVersion: "5.1.0" }) } as any],
      version: "5.1.0",
      store,
      lookup: {
        ensure: async () => ({ missing: [] }),
        refreshToTip: async (ids: string[]) => {
          for (const id of ids) {
            if (id.startsWith("contract")) {
              await store.data.bulkDocs([{ _id: id, _rev: "1-a", namespace: "ns", contract: { "1": "x" }, compiled: { "1": "y" } }], { new_edits: false });
            }
          }
          return { missing: [] };
        },
      },
      contracts: { rebuild } as any,
    } as any);

  it("warns, naming the contract, version and reason, but still bootstraps", async () => {
    const r = await run(async (s) => ({ built: [], failed: [{ version: "1", reason: "no source" }, { version: "2", reason: "bad hash" }] }), ["contract1"]);
    expect(r.network).to.equal("setup@3-s");
    expect(warns).to.deep.equal(["Bootstrap: contract contract1: 1: no source; 2: bad hash"]);
  });
  it("is quiet when every version built", async () => {
    await run(async () => ({ built: ["1"], failed: [] }), ["contract1"]);
    expect(warns).to.deep.equal([]);
  });
  it("skips a contract id whose stream was not served", async () => {
    const seen: string[] = [];
    await run(async (s) => (seen.push(s._id), { built: [], failed: [] }), ["contractA", "missingB"]);
    expect(seen).to.deep.equal(["contractA"]);
  });
});
