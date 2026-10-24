import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { Endpoints } from "../packages/network/src/network/endpoints";

// The entry node stamps $datetime. A client-preset one used to be "refused"
// without returning, then overwritten - but with $expire set, only after it
// was hashed into $umid, so it worked as a free nonce past the Transaction
// Exists check.
describe("ExternalInitalise refuses a preset $datetime", () => {
  let captured: any;
  let originalDirect: any;

  const db: any = {
    exists: async () => false,
    get: async () => {
      throw new Error("not found");
    },
  };
  const host: any = { reference: "entry-node" };

  beforeEach(() => {
    captured = undefined;
    // Stop at the hand-off to consensus and keep what would be sent
    originalDirect = Endpoints.DirectInternalInitalise;
    (Endpoints as any).DirectInternalInitalise = (_host: any, tx: any) => {
      captured = tx;
      return new Promise(() => undefined);
    };
  });

  afterEach(() => {
    (Endpoints as any).DirectInternalInitalise = originalDirect;
  });

  const body = (expire: boolean): any => ({
    $tx: {
      $namespace: "test",
      $contract: "c",
      $i: { a: { x: 1 } },
      ...(expire
        ? { $expire: new Date(Date.now() + 60000).toISOString() }
        : {}),
    },
    $sigs: { a: "sig" },
  });

  // The answer, or undefined once the transaction went to consensus
  const submit = async (b: any) => {
    let answer: any;
    Endpoints.ExternalInitalise(host, b, "1.2.3.4", db).then(
      (r) => (answer = r)
    );
    for (let i = 0; i < 50 && !captured && !answer; i++) {
      await new Promise((r) => setImmediate(r));
    }
    return answer;
  };

  for (const expire of [true, false]) {
    it(`refuses it ${expire ? "with" : "without"} $expire`, async () => {
      const b = body(expire);
      b.$datetime = new Date(0).toISOString();
      const answer = await submit(b);
      expect(answer?.content?.$summary?.errors).to.deep.equal([
        "$datetime cannot be preset",
      ]);
      expect(captured, "never reached consensus").to.equal(undefined);
    });
  }

  it("still stamps its own when none is given", async () => {
    const b = body(true);
    const umid = ActiveCrypto.Hash.getHash(JSON.stringify(b));
    const before = Date.now();
    expect(await submit(b)).to.equal(undefined);
    expect(captured.$umid).to.equal(umid);
    expect(new Date(captured.$datetime).getTime()).to.be.at.least(before);
  });
});
