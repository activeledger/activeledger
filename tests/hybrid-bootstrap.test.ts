import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import {
  BootstrapError,
  bootstrapNode,
  compareVersions,
  isOutdated,
  requiredIds,
  resumeCursor,
  saveCursor,
} from "../packages/hybrid/src/bootstrap";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";
import { neighbourhoodHash } from "../packages/hybrid/src/verify";

const kp = new ActiveCrypto.KeyPair("rsa");
const nodePem = kp.generate().pub.pkcs8pem;
const setup = (over: any = {}) => ({
  _id: "setup",
  _rev: "3-s",
  neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: nodePem } }],
  consensus: { reached: 60 },
  ...over,
});

class FakeUp {
  calls = 0;
  constructor(public id: string, private answer: () => any) {}
  async bootstrap() {
    this.calls++;
    const a = this.answer();
    if (a instanceof Error) throw a;
    return a;
  }
}

describe("versions", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("5.1.0", "5.1.0")).to.equal(0);
    expect(compareVersions("5.10.0", "5.9.9")).to.be.greaterThan(0);
    expect(compareVersions("5.1", "5.1.0")).to.equal(0);
    expect(compareVersions("4.9.9", "5.0.0")).to.be.lessThan(0);
    expect(compareVersions("5.1.0-rc.1", "5.1.0")).to.equal(0);
  });

  it("is outdated only below the minimum", () => {
    expect(isOutdated("5.1.0", "5.1.1")).to.equal(true);
    expect(isOutdated("5.1.1", "5.1.1")).to.equal(false);
    expect(isOutdated("6.0.0", "5.1.1")).to.equal(false);
    expect(isOutdated("5.0.0", undefined)).to.equal(false);
  });

  it("reads required ids from plain and object entries", () => {
    expect(requiredIds(["a", { id: "b", volatile: true }, { id: "" } as any, 5 as any])).to.deep.equal(["a", "b"]);
    expect(requiredIds(undefined as any)).to.deep.equal([]);
  });
});

describe("bootstrapNode", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let refreshed: string[][];
  let rebuilt: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-boot-"));
    store = await openEmbeddedStorage(dir);
    refreshed = [];
    rebuilt = [];
  });
  afterEach(async () => store.close());

  const deps = (upstreams: any[], over: any = {}) => ({
    upstreams,
    version: "5.1.0",
    store,
    lookup: {
      ensure: async () => ({ missing: [] }),
      refreshToTip: async (ids: string[]) => {
        refreshed.push(ids);
        // Pretend the supernode served each contract stream
        for (const id of ids) {
          if (id.startsWith("contract")) {
            await store.data.bulkDocs([{ _id: id, _rev: "1-a", namespace: "ns", contract: { "1": "x" }, compiled: { "1": "y" } }], { new_edits: false });
          }
        }
        return { missing: [] };
      },
    },
    contracts: { rebuild: async (s: any) => (rebuilt.push(s._id), { built: ["1"], failed: [] }) } as any,
    ...over,
  });

  const good = (over: any = {}) => ({
    setup: setup(),
    required: ["req1", { id: "req2", volatile: true }],
    contracts: ["contract1", "contract2"],
    cursor: "umid:9,u9",
    minVersion: "5.1.0",
    ...over,
  });

  it("takes the setup, pulls required streams and builds every contract", async () => {
    const r = await bootstrapNode(deps([new FakeUp("a", () => good())]));
    expect(r.network).to.equal("setup@3-s");
    expect(r.verify.keys.size).to.equal(1);
    expect(r.verify.reachedPercent).to.equal(60);
    expect(r.outdated).to.equal(false);
    expect(refreshed[0]).to.deep.equal(["req1", "req2"]);
    expect(rebuilt.sort()).to.deep.equal(["contract1", "contract2"]);
    expect((await store.data.get("setup"))._rev).to.equal("3-s");
  });

  it("falls through to the next upstream when one fails", async () => {
    const bad = new FakeUp("bad", () => new UpstreamError("down", "network"));
    const ok = new FakeUp("ok", () => good());
    const r = await bootstrapNode(deps([bad, ok]));
    expect(r.upstream.id).to.equal("ok");
    expect(bad.calls).to.equal(1);
  });

  it("refuses an upstream whose setup does not match the pin, and uses the next", async () => {
    const pin = { neighbourhoodSha256: neighbourhoodHash(setup()) };
    const evil = new FakeUp("evil", () => good({ setup: setup({ neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: "evil" } }] }) }));
    const real = new FakeUp("real", () => good());
    const r = await bootstrapNode(deps([evil, real], { pin }));
    expect(r.upstream.id).to.equal("real");
    await store.close();
    store = await openEmbeddedStorage(dir);
  });

  it("fails with the reasons when every upstream is bad, and says refused when all refuse", async () => {
    let err: any;
    try {
      await bootstrapNode(deps([new FakeUp("a", () => new UpstreamError("nope", "refused", 403))]));
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(BootstrapError);
    expect(err.refused).to.equal(true);
    expect(err.message).to.match(/activehybrid register/);

    err = undefined;
    try {
      await bootstrapNode(deps([new FakeUp("a", () => new UpstreamError("down", "network")), new FakeUp("b", () => ({ ...good(), setup: undefined }))]));
    } catch (e) {
      err = e;
    }
    expect(err.refused).to.equal(false);
    expect(err.message).to.contain("a:").and.contain("b:");
    await expectNone();
  });

  const expectNone = async () => expect(rebuilt).to.deep.equal([]);

  it("rejects a setup with no voting keys or no consensus", async () => {
    for (const bad of [setup({ neighbourhood: [] }), setup({ consensus: undefined }), { _id: "s" }]) {
      let err: any;
      try { await bootstrapNode(deps([new FakeUp("a", () => good({ setup: bad }))])); } catch (e) { err = e; }
      expect(err, JSON.stringify(bad)).to.be.instanceOf(BootstrapError);
    }
  });

  it("returns early, pulling nothing, when this release is below the minimum", async () => {
    const r = await bootstrapNode(deps([new FakeUp("a", () => good({ minVersion: "5.2.0" }))]));
    expect(r.outdated).to.equal(true);
    expect(r.minVersion).to.equal("5.2.0");
    expect(refreshed).to.deep.equal([]);
    expect(rebuilt).to.deep.equal([]);
  });

  it("stores and resumes the cursor", async () => {
    expect(await resumeCursor(store, "umid:1,a")).to.equal("umid:1,a");
    await saveCursor(store, "umid:5,e");
    await saveCursor(store, "umid:7,g");
    expect(await resumeCursor(store, "umid:1,a")).to.equal("umid:7,g");
  });
});
