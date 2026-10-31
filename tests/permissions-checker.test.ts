import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
import { Shared } from "../packages/protocol/src/protocol/shared";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";

/**
 * PermissionsChecker paths that authorisation-model.test.ts does not reach:
 * the stream lock rejections, missing streams, multi-signature maps, hardened
 * keys, the pre-authorities signature format, the fetch retry and prefetch.
 * Real RSA keys throughout - a stubbed signature check would prove nothing.
 */

const STREAM = "5c1f9d3a7b2e4c6d8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f506";
const REV = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function keys() {
  const kp = new ActiveCrypto.KeyPair("rsa");
  return { kp, pub: kp.generate().pub.pkcs8pem };
}

const alice = keys();
const bob = keys();
const stranger = keys();

function rows(meta: any = {}, state: any = {}) {
  return [
    { doc: { _id: STREAM, _rev: REV, ...state } },
    {
      doc: {
        _id: `${STREAM}:stream`,
        _rev: REV,
        authorities: [
          { public: alice.pub, type: "rsa", hash: "alice" },
          { public: bob.pub, type: "rsa", hash: "bob" },
        ],
        ...meta,
      },
    },
  ];
}

/** `sigs` builds the $sigs from the transaction body so it is signed over the real thing. */
function entry(sigs: (tx: any) => any, tx: any = {}) {
  const $tx = {
    $namespace: "test",
    $contract: "transfer",
    $i: { [STREAM]: {} },
    $o: {},
    ...tx,
  };
  return { $umid: "umid", $tx, $sigs: sigs($tx), $revs: { $i: {}, $o: {} }, $nodes: {} } as any;
}

function checker(e: any, db: any, security: any = {}) {
  const shared = new Shared(false, e, db, null as any);
  return new PermissionsChecker(
    e,
    db,
    { namespace: {}, hardenedKeys: false, signedOutputs: undefined, ...security } as any,
    shared
  );
}

const dbOf = (r: any[]): any => ({ allDocs: async () => ({ rows: r }) });

async function rejection(p: Promise<any>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("PermissionsChecker - fetch and lock rules", () => {
  const signed = (signer: any) => (tx: any) => ({ [STREAM]: signer.kp.sign(tx) });
  // Retry count 6 is the limit, so a failure surfaces at once instead of waiting out the backoff
  const LAST = 6;

  it("rejects a stream whose contract lock does not include the contract (1700)", async () => {
    const pc = checker(entry(signed(alice)), dbOf(rows({ contractlock: ["other"] })));
    expect((await rejection(pc.process([STREAM], true, LAST))).code).to.equal(1700);
  });

  it("allows a stream whose contract lock includes the contract", async () => {
    const pc = checker(entry(signed(alice)), dbOf(rows({ contractlock: ["transfer"] })));
    expect(await pc.process([STREAM], true, LAST)).to.have.length(1);
  });

  it("rejects a stream whose namespace lock does not include the namespace (1710)", async () => {
    const pc = checker(entry(signed(alice)), dbOf(rows({ namespaceLock: ["elsewhere"] })));
    expect((await rejection(pc.process([STREAM], true, LAST))).code).to.equal(1710);
  });

  it("allows a stream whose namespace lock includes the namespace", async () => {
    const pc = checker(entry(signed(alice)), dbOf(rows({ namespaceLock: ["test"] })));
    expect(await pc.process([STREAM], true, LAST)).to.have.length(1);
  });

  it("reports missing streams as 950", async () => {
    const pc = checker(entry(signed(alice)), dbOf([]));
    const err = await rejection(pc.process([STREAM], true, LAST));
    expect(err.code).to.equal(950);
    expect(err.reason).to.equal("Stream(s) not found");
  });

  it("reports a stream that has state but no :stream document as 950", async () => {
    const pc = checker(entry(signed(alice)), dbOf([rows()[0]]));
    const err = await rejection(pc.process([STREAM], true, LAST));
    expect(err.code).to.equal(950);
    expect(err.reason).to.equal("Stream(s) not found");
  });

  it("gives an unexpected fetch failure code 950 once retries are exhausted", async () => {
    const pc = checker(entry(signed(alice)), { allDocs: async () => { throw new Error("db down"); } } as any);
    expect((await rejection(pc.process([STREAM], true, LAST))).code).to.equal(950);
  });

  it("retries a failed fetch and succeeds once the data is there", async () => {
    let calls = 0;
    const db: any = {
      allDocs: async () => {
        if (++calls === 1) throw new Error("not finalised yet");
        return { rows: rows() };
      },
    };
    const pc = checker(entry(signed(alice)), db);
    expect(await pc.process([STREAM], true)).to.have.length(1);
    expect(calls).to.equal(2);
  });

  it("fetches both input and output sets in one request with prefetch()", async () => {
    const OUT = "6d2f0e4b8c3f5d7e9a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f50617";
    const e = entry(signed(alice), { $i: { [STREAM]: {} }, $o: { [OUT]: {} } });
    let calls = 0;
    const db: any = {
      allDocs: async ({ keys }: any) => {
        calls++;
        return {
          rows: [
            ...rows(),
            { doc: { _id: OUT, _rev: REV } },
            { doc: { _id: `${OUT}:stream`, _rev: REV, authorities: [] } },
          ].filter((r) => keys.includes(r.doc._id)),
        };
      },
    };
    const pc = checker(e, db);
    await pc.prefetch([[STREAM], [OUT]]);
    expect((await pc.process([STREAM], true)).map((s) => s.state._id)).to.deep.equal([STREAM]);
    expect((await pc.process([OUT], false)).map((s) => s.state._id)).to.deep.equal([OUT]);
    expect(calls).to.equal(1);
  });

  it("does not ask for the :stream document of a contract :data id", async () => {
    let requested: string[] = [];
    const db: any = { allDocs: async ({ keys }: any) => { requested = keys; return { rows: [] }; } };
    const pc = checker(entry(signed(alice)), db);
    await rejection(pc.process([`${STREAM}:data`], false, LAST));
    expect(requested).to.deep.equal([`${STREAM}:data`]);
  });
});

describe("PermissionsChecker - signatures", () => {
  const LAST = 6;

  it("accepts a multi-signature map where every signature matches a distinct authority hash", async () => {
    const e = entry((tx) => ({ [STREAM]: { alice: alice.kp.sign(tx), bob: bob.kp.sign(tx) } }));
    expect(await checker(e, dbOf(rows())).process([STREAM], true)).to.have.length(1);
  });

  it("rejects a multi-signature map with more entries than authorities (1225)", async () => {
    const e = entry((tx) => ({
      [STREAM]: { alice: alice.kp.sign(tx), bob: bob.kp.sign(tx), eve: stranger.kp.sign(tx) },
    }));
    expect((await rejection(checker(e, dbOf(rows())).process([STREAM], true, LAST))).code).to.equal(1225);
  });

  it("rejects a multi-signature map where one signature is by the wrong key (1220)", async () => {
    const e = entry((tx) => ({ [STREAM]: { alice: alice.kp.sign(tx), bob: stranger.kp.sign(tx) } }));
    expect((await rejection(checker(e, dbOf(rows())).process([STREAM], true, LAST))).code).to.equal(1220);
  });

  it("rejects a multi-signature map keyed by a hash that is not an authority (1220)", async () => {
    const e = entry((tx) => ({ [STREAM]: { nobody: alice.kp.sign(tx) } }));
    expect((await rejection(checker(e, dbOf(rows())).process([STREAM], true, LAST))).code).to.equal(1220);
  });

  it("remaps a simple signature to the matching authority hash for later stages", async () => {
    const e = entry((tx) => ({ [STREAM]: bob.kp.sign(tx) }));
    await checker(e, dbOf(rows())).process([STREAM], true);
    expect(Object.keys(e.$sigs[STREAM])).to.deep.equal(["bob"]);
  });

  it("rejects a simple signature from nobody on the authority list (1220)", async () => {
    const e = entry((tx) => ({ [STREAM]: stranger.kp.sign(tx) }));
    expect((await rejection(checker(e, dbOf(rows())).process([STREAM], true, LAST))).code).to.equal(1220);
  });

  describe("streams from before authorities existed", () => {
    const legacy = (type?: string) =>
      rows({ authorities: undefined, public: alice.pub, ...(type ? { type } : {}) });

    it("verifies against meta.public, defaulting the type to rsa", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }));
      expect(await checker(e, dbOf(legacy())).process([STREAM], true)).to.have.length(1);
    });

    it("rejects a signature by another key (1220)", async () => {
      const e = entry((tx) => ({ [STREAM]: stranger.kp.sign(tx) }));
      expect((await rejection(checker(e, dbOf(legacy("rsa"))).process([STREAM], true, LAST))).code).to.equal(1220);
    });
  });

  describe("hardened keys", () => {
    it("rejects an input that does not carry $nhpk (1230)", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }));
      const pc = checker(e, dbOf(rows()), { hardenedKeys: true });
      expect((await rejection(pc.process([STREAM], true, LAST))).code).to.equal(1230);
    });

    it("accepts a single signature on an input that carries $nhpk", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }), { $i: { [STREAM]: { $nhpk: "key" } } });
      const pc = checker(e, dbOf(rows()), { hardenedKeys: true });
      expect(await pc.process([STREAM], true)).to.have.length(1);
    });
  });
});
