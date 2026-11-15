import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
import { Shared } from "../packages/protocol/src/protocol/shared";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";

/**
 * What PermissionsChecker promises that a mutation pass found nothing
 * checking: the stored position is only enforced for a stream that is not
 * sigOnly, the fetch retries a fixed number of times and then gives up with
 * the original error, and the fetch asks for the documents themselves.
 */

const STREAM = "5c1f9d3a7b2e4c6d8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f506";
const REV = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const alice = (() => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  return { kp, pub: kp.generate().pub.pkcs8pem };
})();

const rows = () => [
  { doc: { _id: STREAM, _rev: REV } },
  { doc: { _id: `${STREAM}:stream`, _rev: REV, authorities: [{ public: alice.pub, type: "rsa", hash: "alice" }] } },
];

function entry(tx: any = {}) {
  const $tx = { $namespace: "test", $contract: "transfer", $i: { [STREAM]: {} }, $o: {}, ...tx };
  return { $umid: "umid", $tx, $sigs: { [STREAM]: alice.kp.sign($tx) }, $revs: { $i: {}, $o: {} }, $nodes: {} } as any;
}

function build(e: any, db: any) {
  const shared = new Shared(false, e, db, null as any);
  const pc = new PermissionsChecker(e, db, { namespace: {}, hardenedKeys: false, signedOutputs: undefined } as any, shared);
  return { pc, shared };
}

const rejection = async (p: Promise<any>) => {
  try {
    await p;
  } catch (e) {
    return e as any;
  }
  throw new Error("expected a rejection");
};

describe("PermissionsChecker - the recorded stream position", () => {
  it("accepts the same position again once it has been recorded", async () => {
    const e = entry();
    const { pc } = build(e, { allDocs: async () => ({ rows: rows() }) });
    await pc.process([STREAM], true);
    expect(e.$revs.$i[STREAM]).to.equal(`${REV}:${REV}`);
    // a second pass over the same, unchanged stream is not a mismatch
    expect(await pc.process([STREAM], true)).to.have.length(1);
  });

  it("does not enforce the recorded position for a sigOnly stream", async () => {
    const e = entry({ $i: { [STREAM]: { $sigOnly: true } } });
    e.$sigs = { [STREAM]: alice.kp.sign(e.$tx) };
    const { pc, shared } = build(e, { allDocs: async () => ({ rows: rows() }) });
    shared.sigOnly[STREAM] = true;
    e.$revs.$i[STREAM] = "9-x:9-y";
    // not rejected with 1200. A sigOnly stream is checked for its signature only,
    // so it is not among the streams handed back either.
    let rejected: any;
    try {
      await pc.process([STREAM], true, 6);
    } catch (error) {
      rejected = error;
    }
    expect(rejected, rejected && JSON.stringify(rejected)).to.equal(undefined);
  });

  it("does enforce it for a stream that is not sigOnly (1200)", async () => {
    const e = entry();
    const { pc } = build(e, { allDocs: async () => ({ rows: rows() }) });
    e.$revs.$i[STREAM] = "9-x:9-y";
    expect((await rejection(pc.process([STREAM], true, 6))).code).to.equal(1200);
  });
});

describe("PermissionsChecker - fetching the streams", () => {
  // The wait between retries is real time; the checker sleeps through a method
  // a test can replace.
  const failing = () => {
    const calls = { allDocs: 0, sleeps: 0 };
    const error = new Error("storage down");
    const e = entry();
    const { pc } = build(e, {
      allDocs: async () => {
        calls.allDocs++;
        throw error;
      },
    });
    (pc as any).sleep = async () => {
      // a loop that never ends must not hang the run
      if (++calls.sleeps > 50) throw new Error("retrying without end");
    };
    return { pc, calls, error };
  };

  it("tries once and then retries six times before giving up with the original error", async () => {
    const { pc, calls, error } = failing();
    const got = await rejection(pc.process([STREAM], true));
    expect(got).to.equal(error);
    expect(calls.allDocs, "the first try and six retries").to.equal(7);
    expect(calls.sleeps).to.equal(6);
  });

  it("gives up straight away when it is already on the last retry", async () => {
    const { pc, calls } = failing();
    await rejection(pc.process([STREAM], true, 6));
    expect(calls.allDocs).to.equal(1);
    expect(calls.sleeps).to.equal(0);
  });

  it("has one retry left from retry 5", async () => {
    const { pc, calls } = failing();
    await rejection(pc.process([STREAM], true, 5));
    expect(calls.allDocs).to.equal(2);
  });

  it("recovers when a retry finds the streams", async () => {
    const e = entry();
    let calls = 0;
    const { pc } = build(e, {
      allDocs: async () => {
        if (++calls < 3) throw new Error("not written yet");
        return { rows: rows() };
      },
    });
    (pc as any).sleep = async () => undefined;
    expect(await pc.process([STREAM], true)).to.have.length(1);
    expect(calls).to.equal(3);
  });

  it("reads the documents themselves, not only their ids", async () => {
    const seen: any[] = [];
    const { pc } = build(entry(), {
      allDocs: async (options: any) => {
        seen.push(options);
        return { rows: rows() };
      },
    });
    await pc.process([STREAM], true);
    expect(seen.length).to.be.greaterThan(0);
    for (const o of seen) expect(o.include_docs).to.equal(true);
  });

  it("treats the data as inputs when not told otherwise", async () => {
    const e = entry();
    const { pc } = build(e, { allDocs: async () => ({ rows: rows() }) });
    await pc.process([STREAM]);
    expect(Object.keys(e.$revs.$i)).to.deep.equal([STREAM]);
    expect(Object.keys(e.$revs.$o)).to.deep.equal([]);
  });
});
