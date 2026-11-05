import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
import { Shared } from "../packages/protocol/src/protocol/shared";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";

const STREAM = "5c1f9d3a7b2e4c6d8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f506";
const OTHER = "6d2f0e4b8c3f5d7e9a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f50617";
const REV = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LAST = 6;

const mk = () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  return { kp, pub: kp.generate().pub.pkcs8pem };
};
const alice = mk();
const bob = mk();

function entry(sigs: (tx: any) => any, tx: any = {}, revs: any = { $i: {}, $o: {} }) {
  const $tx = {
    $namespace: "test",
    $contract: "transfer",
    $i: { [STREAM]: {} },
    $o: {},
    ...tx,
  };
  return { $umid: "umid", $tx, $sigs: sigs($tx), $revs: revs, $nodes: {} } as any;
}

function checker(e: any, db: any, security: any = {}, shared?: Shared) {
  const sh = shared || new Shared(false, e, db, null as any);
  return {
    pc: new PermissionsChecker(
      e,
      db,
      { namespace: {}, hardenedKeys: false, signedOutputs: undefined, ...security } as any,
      sh
    ),
    shared: sh,
  };
}

const state = (id = STREAM) => ({ doc: { _id: id, _rev: REV } });
const meta = (extra: any = {}, id = STREAM) => ({
  doc: {
    _id: `${id}:stream`,
    _rev: REV,
    authorities: [
      { public: alice.pub, type: "rsa", hash: "alice" },
      { public: bob.pub, type: "rsa", hash: "bob" },
    ],
    ...extra,
  },
});
const dbOf = (r: any[]): any => ({ allDocs: async () => ({ rows: r }) });

async function rejection(p: Promise<any>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("PermissionsChecker extra behaviour (cov)", () => {
  describe("contract :data streams", () => {
    const dataId = `${STREAM}:data`;

    it("gets a synthetic meta document so the rest of the checks work", async () => {
      const e = entry(() => ({}), { $i: {}, $o: { [dataId]: {} } });
      const { pc } = checker(e, dbOf([{ doc: { _id: dataId, _rev: REV } }]));
      const out = await pc.process([dataId], false);
      expect(out).to.have.length(1);
      expect(out[0].state._id).to.equal(dataId);
      expect(out[0].meta).to.deep.equal({ _id: `${dataId}:meta`, _rev: "0-context" });
      // the position of the stream is recorded as meta rev : state rev
      expect(e.$revs.$o[dataId]).to.equal(`0-context:${REV}`);
    });

    describe("mixed with ordinary streams", () => {
      const run = async (ids: string[]) => {
        const e = entry(() => ({}), { $i: {}, $o: { [dataId]: {}, [OTHER]: {} } });
        const db = dbOf([
          { doc: { _id: dataId, _rev: REV } },
          state(OTHER),
          meta({}, OTHER),
        ]);
        const { pc } = checker(e, db);
        return pc.process(ids, false);
      };

      for (const ids of [[dataId, OTHER], [OTHER, dataId]]) {
        it(`accepts ${ids.map((i) => (i === dataId ? "data" : "plain")).join(" then ")} and keeps the real meta of the plain stream`, async () => {
          const out = await run(ids);
          expect(out).to.have.length(2);
          const plain = out.find((r) => r.state._id === OTHER)!;
          const data = out.find((r) => r.state._id === dataId)!;
          expect(plain.meta._id).to.equal(`${OTHER}:stream`);
          expect(plain.meta._rev).to.equal(REV);
          expect(data.meta).to.deep.equal({ _id: `${dataId}:meta`, _rev: "0-context" });
        });
      }

      it("does not invent meta for an ordinary stream when only data ids sit elsewhere in the list", async () => {
        const e = entry(() => ({}), { $i: {}, $o: { [OTHER]: {} } });
        const { pc } = checker(e, dbOf([state(OTHER)]));
        const err = await rejection(pc.process([OTHER], false, LAST));
        expect(err.code).to.equal(950);
      });
    });

    it("is still a missing stream (950) when the data document does not exist", async () => {
      const e = entry(() => ({}), { $i: {}, $o: { [dataId]: {} } });
      const { pc } = checker(e, dbOf([]));
      const err = await rejection(pc.process([dataId], false, LAST));
      expect(err.code).to.equal(950);
    });

    it("rejects a data stream whose recorded position differs (1200)", async () => {
      const e = entry(() => ({}), { $i: {}, $o: { [dataId]: {} } }, {
        $i: {},
        $o: { [dataId]: `0-context:2-bbbb` },
      });
      const { pc } = checker(e, dbOf([{ doc: { _id: dataId, _rev: REV } }]));
      const err = await rejection(pc.process([dataId], false, LAST));
      expect(err.code).to.equal(1200);
      expect(err.reason).to.equal(
        `Output Stream Position Incorrect (0-context:2-bbbb !== 0-context:${REV} - Local)`
      );
    });
  });

  describe("revision position", () => {
    it("records the position the first time and rejects a mismatch afterwards (1200)", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }));
      const { pc } = checker(e, dbOf([state(), meta()]));
      await pc.process([STREAM], true);
      expect(e.$revs.$i[STREAM]).to.equal(`${REV}:${REV}`);
      e.$revs.$i[STREAM] = "9-x:9-y";
      const err = await rejection(pc.process([STREAM], true, LAST));
      expect(err.code).to.equal(1200);
      expect(err.reason).to.equal(
        `Input Stream Position Incorrect (9-x:9-y !== ${REV}:${REV} - Local)`
      );
    });

    it("uses the Output wording for output streams", async () => {
      const e = entry(() => ({}), { $i: {}, $o: { [STREAM]: {} } }, {
        $i: {},
        $o: { [STREAM]: "9-x:9-y" },
      });
      const { pc } = checker(e, dbOf([state(), meta()]));
      const err = await rejection(pc.process([STREAM], false, LAST));
      expect(err.reason).to.contain("Output Stream Position Incorrect");
    });
  });

  describe("outputs", () => {
    it("are not signature checked unless signedOutputs is on", async () => {
      const e = entry(() => ({ [STREAM]: "junk" }), { $i: {}, $o: { [STREAM]: {} } });
      const { pc } = checker(e, dbOf([state(), meta()]));
      expect(await pc.process([STREAM], false)).to.have.length(1);
    });

    it("are checked, and worded as Output, when signedOutputs is on", async () => {
      const e = entry(() => ({ [STREAM]: "junk" }), { $i: {}, $o: { [STREAM]: {} } });
      const { pc } = checker(e, dbOf([state(), meta()]), { signedOutputs: true });
      const err = await rejection(pc.process([STREAM], false, LAST));
      expect(err.code).to.equal(1220);
      expect(err.reason).to.equal("Output Signature Incorrect");
    });
  });

  describe("hardened keys with a signature map", () => {
    it("never accepts a multi-signature on a hardened-key input (reported as 1220)", async () => {
      const e = entry(
        (tx) => ({ [STREAM]: { alice: alice.kp.sign(tx) } }),
        { $i: { [STREAM]: { $nhpk: "key" } } }
      );
      const { pc } = checker(e, dbOf([state(), meta()]), { hardenedKeys: true });
      const err = await rejection(pc.process([STREAM], true, LAST));
      expect(err.code).to.equal(1220);
      expect(err.reason).to.equal("Input Signature Incorrect");
    });

    it("the same multi-signature is accepted when hardened keys are off", async () => {
      const e = entry((tx) => ({ [STREAM]: { alice: alice.kp.sign(tx) } }));
      const { pc } = checker(e, dbOf([state(), meta()]));
      expect(await pc.process([STREAM], true)).to.have.length(1);
    });
  });

  describe("signature only inputs", () => {
    const sigOnlyEntry = (signer: any) =>
      entry((tx) => ({ [STREAM]: signer.kp.sign(tx) }), {
        $i: { [STREAM]: { $sigOnly: true } },
      });

    it("only ask for the stream document, and are dropped from the result once verified", async () => {
      const e = sigOnlyEntry(alice);
      const sh = new Shared(false, e, {} as any, null as any);
      sh.sigOnly[STREAM] = true;
      let requested: string[] = [];
      const db: any = {
        allDocs: async ({ keys }: any) => {
          requested = keys;
          return { rows: [meta()] };
        },
      };
      const { pc } = checker(e, db, {}, sh);
      expect(await pc.process([STREAM], true, LAST)).to.deep.equal([]);
      expect(requested).to.deep.equal([`${STREAM}:stream`]);
      // no state document was read, so no position can be recorded for it
      expect(e.$revs.$i[STREAM]).to.equal(undefined);
    });

    it("are still rejected when the signature is wrong (1220)", async () => {
      const e = sigOnlyEntry(alice);
      e.$sigs[STREAM] = "bad" + e.$sigs[STREAM];
      const sh = new Shared(false, e, {} as any, null as any);
      sh.sigOnly[STREAM] = true;
      const { pc } = checker(e, dbOf([meta()]), {}, sh);
      expect((await rejection(pc.process([STREAM], true, LAST))).code).to.equal(1220);
    });

    it("a stream that is NOT sigOnly must have its state document: meta alone is rejected (950)", async () => {
      // Valid signature, valid meta, but the state document is missing and the
      // transaction did not ask for sigOnly. Nothing would then check its position,
      // so it must fail rather than be treated as if it were signature only.
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }), { $i: { [STREAM]: {} } });
      const { pc } = checker(e, dbOf([meta()]));
      const err = await rejection(pc.process([STREAM], true, LAST));
      expect(err.code).to.equal(950);
    });

    it("the same stream marked sigOnly is still accepted without a state document", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }), { $i: { [STREAM]: { $sigOnly: true } } });
      const sh = new Shared(false, e, {} as any, null as any);
      sh.sigOnly[STREAM] = true;
      const { pc } = checker(e, dbOf([meta()]), {}, sh);
      expect(await pc.process([STREAM], true, LAST)).to.deep.equal([]);
    });

    it("do not need the revisions to agree", async () => {
      const e = entry((tx) => ({ [STREAM]: alice.kp.sign(tx) }), { $i: { [STREAM]: {} } }, {
        $i: { [STREAM]: "9-x:9-y" },
        $o: {},
      });
      const sh = new Shared(false, e, {} as any, null as any);
      sh.sigOnly[STREAM] = true;
      const { pc } = checker(e, dbOf([meta()]), {}, sh);
      expect(await pc.process([STREAM], true, LAST)).to.deep.equal([]);
    });
  });
});
