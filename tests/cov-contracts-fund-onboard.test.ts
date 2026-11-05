import { expect } from "chai";
import "mocha";
import Onboard from "../packages/activeledger/src/contracts/default/onboard";

const refusal = async (p: Promise<any>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal but it resolved");
};

// A tiny activity that records exactly what was written to it.
const activity = (initial: any = {}) => {
  const a: any = {
    state: initial,
    sets: 0,
    getState: () => a.state,
    setState: (s: any) => {
      a.state = s;
      a.sets++;
    },
  };
  return a;
};

describe("Default onboard contract", () => {
  describe("verify", () => {
    it("accepts a signatureless transaction", async () => {
      expect(await Onboard.prototype.verify.call({}, true)).to.equal(true);
    });
    it("rejects a signed transaction", async () => {
      expect(await refusal(Onboard.prototype.verify.call({}, false))).to.equal(
        "Should be a sigsless flagged transaction"
      );
    });
  });

  it("vote always approves", async () => {
    expect(await Onboard.prototype.vote.call({})).to.equal(true);
  });

  describe("commit", () => {
    const build = (inputs: any, ns = "myns", volatileError?: Error) => {
      const created: any[] = [];
      const c: any = Object.create(Onboard.prototype);
      c.transactions = { $i: inputs, $namespace: ns };
      c.newActivityStream = (name: string) => {
        const act: any = {
          name,
          authority: null as any,
          state: {} as any,
          volatile: { v: 1 } as any,
          volatileSet: null as any,
          setAuthority: (k: string, t: string) => (act.authority = [k, t]),
          getName: () => "n:" + name,
          getState: () => act.state,
          setState: (s: any) => (act.state = s),
          getVolatile: () =>
            volatileError ? Promise.reject(volatileError) : Promise.resolve(act.volatile),
          setVolatile: (v: any) => (act.volatileSet = v),
        };
        created.push(act);
        return act;
      };
      return { c, created };
    };
    const tick = () => new Promise((r) => setImmediate(r));

    it("creates one identity stream per input with authority, name, type and volatile now", async () => {
      const { c, created } = build({
        alice: { publicKey: "PUBA", type: "rsa" },
        bob: { publicKey: "PUBB", type: "secp256k1" },
      });
      expect(await c.commit()).to.equal(true);
      await tick();
      expect(created.map((a) => a.name).sort()).to.deep.equal([
        "activeledger.default.identity.alice",
        "activeledger.default.identity.bob",
      ]);
      for (const a of created) {
        const who = a.name.endsWith("alice") ? ["PUBA", "rsa"] : ["PUBB", "secp256k1"];
        expect(a.authority).to.deep.equal(who);
        expect(a.state.name).to.equal("n:" + a.name);
        expect(a.state.type).to.equal("myns.activeledger.identity");
        expect(a.volatileSet.v).to.equal(1);
        expect(a.volatileSet.now).to.be.instanceOf(Date);
      }
    });

    it("resolves true with no inputs and creates nothing", async () => {
      const { c, created } = build({});
      expect(await c.commit()).to.equal(true);
      expect(created).to.have.length(0);
    });

    it("a volatile failure rejects the commit and does not set volatile", async () => {
      const { c, created } = build({ a: { publicKey: "P", type: "rsa" } }, "ns", new Error("nope"));
      let err: any;
      try {
        await c.commit();
      } catch (e) {
        err = e;
      }
      expect(err && err.message).to.equal("nope");
      expect(created[0].volatileSet).to.equal(null);
    });

    it("has made every volatile write by the time commit resolves, even a slow one", async () => {
      const { c, created } = build({
        a: { publicKey: "PA", type: "rsa" },
        b: { publicKey: "PB", type: "rsa" },
      });
      const make = c.newActivityStream;
      let n = 0;
      c.newActivityStream = (name: string) => {
        const act = make(name);
        const delay = ++n * 20;
        const original = act.getVolatile;
        act.getVolatile = () => new Promise((r) => setTimeout(r, delay)).then(original);
        return act;
      };
      expect(await c.commit()).to.equal(true);
      // No tick: the writes must already be there
      for (const a of created) expect(a.volatileSet && a.volatileSet.now).to.be.instanceOf(Date);
    });
  });
});
