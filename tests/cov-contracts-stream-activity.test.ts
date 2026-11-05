import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";

// A new (output) activity: umid + name.   An input activity: signature = true.
const fresh = (em = new EventEmitter()) => new Activity("umid1", "nm", false, em);
const input = (meta: any = {}, state: any = {}, em = new EventEmitter()) =>
  new Activity("umid1", null, true, em, { _id: "i:stream", _rev: "1", ...meta }, { _id: "i", _rev: "1", ...state }, "tx1");
const output = () => new Activity("umid1", null, false, new EventEmitter(), { _id: "o:stream", _rev: "1" } as any, { _id: "o", _rev: "1" } as any);

const msg = (fn: () => any) => {
  try {
    fn();
  } catch (e: any) {
    return e.message;
  }
  throw new Error("expected a throw");
};
const auth = (public_: string, extra: any = {}) => ({ public: public_, type: "rsa", stake: 100, ...extra } as any);

describe("Activity (contract stream) - safe mode", () => {
  it("setSafeMode blocks every mutator with its own message", () => {
    const a = fresh();
    a.setSafeMode();
    expect(msg(() => a.setAuthority("k"))).to.equal("Cannot set authority in Safe Mode");
    expect(msg(() => a.setAuthorities(auth("k")))).to.equal("Cannot set authorities in Safe Mode");
    expect(msg(() => a.deleteAuthorities("k"))).to.equal("Cannot delete authorities in Safe Mode");
    expect(msg(() => a.setContractLock("c"))).to.equal("Cannot create set contract lock in Safe Mode");
    expect(msg(() => a.setNamespaceLock("n"))).to.equal("Cannot create set namespace lock in Safe Mode");
    expect(msg(() => a.setState({ a: 1 }))).to.equal("Cannot create set state in Safe Mode");
  });
  it("safe mode is off by default", () => {
    const a = fresh();
    a.setContractLock("c");
    a.setState({ x: 1 });
    expect(a.getState()).to.deep.include({ x: 1 });
  });
});

describe("Activity - authorities", () => {
  it("setAuthority replaces authorities with one 100-stake entry carrying hash and tx umid", () => {
    const a = input();
    a.setAuthority("PUB", "secp256k1");
    expect(a.getAuthority()).to.equal("PUB");
    expect(a.getAuthority(true)).to.equal("secp256k1");
    expect(a.updatedMeta).to.equal(true);
    expect(a.updated).to.equal(true);
    const meta = (a as any).meta;
    expect(meta.authorities).to.have.length(1);
    expect(meta.authorities[0]).to.include({ public: "PUB", type: "secp256k1", stake: 100, umid: "tx1" });
    expect(meta.authorities[0].hash).to.match(/^[0-9a-f]{64}$/);
  });
  it("setAuthority defaults the type to rsa", () => {
    const a = fresh();
    a.setAuthority("PUB");
    expect(a.getAuthority(true)).to.equal("rsa");
  });
  it("setAuthority on an output stream is refused", () => {
    expect(msg(() => output().setAuthority("k"))).to.equal("Cannot set new authority on output stream");
  });
  it("setAuthorities on an output stream is refused", () => {
    expect(msg(() => output().setAuthorities(auth("k")))).to.equal("Cannot set new authorities on output stream");
  });
  it("deleteAuthorities on an output stream is refused", () => {
    expect(msg(() => output().deleteAuthorities("k"))).to.equal("Cannot delete authorities on output stream");
  });

  it("setAuthorities accepts a single value, derives hash and umid, and de-duplicates keeping the newest", () => {
    const a = input({ authorities: [auth("A", { hash: "ha", label: "old" })] });
    a.setAuthorities(auth("A", { hash: "ha", label: "new" }));
    const list = (a as any).meta.authorities;
    expect(list).to.have.length(1);
    expect(list[0].label).to.equal("new");
    expect(list[0].umid).to.equal("tx1");
  });
  it("setAuthorities creates the array when none exists and accepts arrays", () => {
    const a = input();
    a.setAuthorities([auth("A"), auth("B")]);
    expect((a as any).meta.authorities.map((x: any) => x.public)).to.deep.equal(["A", "B"]);
    expect((a as any).meta.authorities[0].hash).to.match(/^[0-9a-f]{64}$/);
  });
  it("setAuthorities refuses to leave only expiring authorities and leaves meta untouched", () => {
    const a = input({ authorities: [auth("A", { hash: "ha" })] });
    a.updatedMeta = false;
    const err = msg(() =>
      a.setAuthorities([auth("A", { hash: "ha", expire: 99999999999 })])
    );
    expect(err).to.equal("Operation denied this would expire every authority");
    expect((a as any).meta.authorities[0].expire).to.equal(undefined);
    expect(a.updatedMeta).to.equal(false);
  });

  describe("deleteAuthorities", () => {
    const three = () =>
      input({
        authorities: [
          auth("A", { hash: "ha", label: "la", umid: "ua" }),
          auth("B", { hash: "hb", label: "lb", umid: "ub" }),
          auth("C", { hash: "hc", label: "lc", umid: "uc" }),
        ],
      });
    const keys = (a: any) => a.meta.authorities.map((x: any) => x.public);

    it("removes by single key and records an audit entry without the public key", () => {
      const a = three();
      a.deleteAuthorities("B");
      expect(keys(a)).to.deep.equal(["A", "C"]);
      expect((a as any).meta.removedAuthorities).to.deep.equal([
        { hash: "hb", label: "lb", umid: "ub", revoked: "tx1" },
      ]);
      expect(a.updatedMeta).to.equal(true);
    });
    it("removes by array of keys, appending to existing history", () => {
      const a = three();
      (a as any).meta.removedAuthorities = [{ hash: "old" }];
      a.deleteAuthorities(["A", "C", "Z"]);
      expect(keys(a)).to.deep.equal(["B"]);
      expect((a as any).meta.removedAuthorities.map((x: any) => x.hash)).to.deep.equal(["old", "ha", "hc"]);
    });
    it("removes by filter function", () => {
      const a = three();
      a.deleteAuthorities((x: any) => x.label !== "lb");
      expect(keys(a)).to.deep.equal(["B"]);
    });
    it("removing nothing leaves authorities and adds no history", () => {
      const a = three();
      a.deleteAuthorities("nobody");
      expect(keys(a)).to.deep.equal(["A", "B", "C"]);
      expect((a as any).meta.removedAuthorities).to.equal(undefined);
    });
    it("refuses to delete every authority", () => {
      const a = three();
      expect(msg(() => a.deleteAuthorities(["A", "B", "C"]))).to.equal(
        "Operation denied this will delete all authorities"
      );
      expect(keys(a)).to.deep.equal(["A", "B", "C"]);
    });
    it("refuses to remove the last permanent authority", () => {
      const a = input({
        authorities: [auth("A", { hash: "ha" }), auth("B", { hash: "hb", expire: 9e12 })],
      });
      expect(msg(() => a.deleteAuthorities("A"))).to.equal(
        "Operation denied this would expire every authority"
      );
      expect(keys(a)).to.deep.equal(["A", "B"]);
    });
  });

  describe("getAuthority", () => {
    it("degrades to meta.public / meta.type without an authorities array", () => {
      const a = input({ public: "LEG", type: "legacy" });
      expect(a.getAuthority()).to.equal("LEG");
      expect(a.getAuthority(true)).to.equal("legacy");
    });
    it("returns the first authority", () => {
      const a = input({ authorities: [auth("A", { type: "t1" }), auth("B", { type: "t2" })] });
      expect(a.getAuthority()).to.equal("A");
      expect(a.getAuthority(true)).to.equal("t1");
    });
    it("is undefined for an empty authorities array", () => {
      const a = input({ authorities: [] });
      expect(a.getAuthority()).to.equal(undefined);
      expect(a.getAuthority(true)).to.equal(undefined);
    });
  });
});

describe("Activity - getAuthorities", () => {
  it("returns the authorities array, or undefined when none were set", () => {
    const list = [auth("A", { hash: "ha" })];
    expect(input({ authorities: list }).getAuthorities()).to.deep.equal(list);
    expect(input().getAuthorities()).to.equal(undefined);
  });
});

describe("Activity - locks", () => {
  it("setContractLock stores a string as a one-item list", () => {
    const a = fresh();
    expect(a.setContractLock("c1")).to.equal(true);
    expect((a as any).meta.contractlock).to.deep.equal(["c1"]);
  });
  it("setContractLock stores an array as given", () => {
    const a = fresh();
    expect(a.setContractLock(["c1", "c2"])).to.equal(true);
    expect((a as any).meta.contractlock).to.deep.equal(["c1", "c2"]);
  });
  it("setContractLock returns false and sets nothing on an existing stream", () => {
    const a = input();
    expect(a.setContractLock("c1")).to.equal(false);
    expect((a as any).meta.contractlock).to.equal(undefined);
  });
  it("setNamespaceLock string, array and false cases", () => {
    const a = fresh();
    expect(a.setNamespaceLock("ns")).to.equal(true);
    expect((a as any).meta.namespaceLock).to.deep.equal(["ns"]);
    expect(a.setNamespaceLock(["a", "b"])).to.equal(true);
    expect((a as any).meta.namespaceLock).to.deep.equal(["a", "b"]);
    const b = input();
    expect(b.setNamespaceLock("ns")).to.equal(false);
    expect((b as any).meta.namespaceLock).to.equal(undefined);
  });
});

describe("Activity - state, id, cng", () => {
  it("getId equals the sha256 stream id and getState hides _id/_rev", () => {
    const a = fresh();
    expect(a.getId()).to.match(/^[0-9a-f]{64}$/);
    expect(a.getName()).to.equal(a.getId());
    expect(a.getState()).to.deep.equal({ _rev: null });
  });
  it("getCng sums char codes of state _rev + buffer + meta _rev", () => {
    const a = new Activity("u", null, true, new EventEmitter(), { _id: "m", _rev: "b" } as any, { _id: "s", _rev: "a" } as any);
    // "a" + "c" + "b" = 97 + 99 + 98
    expect(a.getCng("c")).to.equal(294);
    expect(a.getCng("")).to.equal(195);
  });
});

describe("Activity - getVolatile", () => {
  it("returns a deep copy without _id/_rev when volatile is held", async () => {
    const a = fresh();
    a.setVolatile({ k: { n: 1 } } as any);
    const v: any = await a.getVolatile();
    expect(v).to.deep.equal({ _rev: null, k: { n: 1 } });
    v.k.n = 2;
    expect(((await a.getVolatile()) as any).k.n).to.equal(1);
  });
  it("rejects as Invalid when the held volatile cannot be copied", async () => {
    const a = fresh();
    const cyc: any = {};
    cyc.self = cyc;
    (a as any).volatile = cyc;
    let err: any;
    try {
      await a.getVolatile();
    } catch (e) {
      err = e;
    }
    expect(err).to.equal("Volatile Data - Invalid");
  });
  describe("fetched through the emitter", () => {
    const fetched = (em: EventEmitter, umid: string, id: string, ...args: any[]) =>
      em.emit(`volatileFetched-${umid}${id}`, ...args);

    it("emits getVolatile and resolves with the fetched data", async () => {
      const em = new EventEmitter();
      const a = input({}, {}, em);
      (a as any).volatile = undefined;
      let asked: any[] = [];
      em.on("getVolatile", (...x) => {
        asked = x;
        setImmediate(() => fetched(em, "umid1", "i", null, { _id: "x", _rev: "2", hello: "w" }));
      });
      const v: any = await a.getVolatile();
      expect(asked).to.deep.equal(["umid1", "i"]);
      expect(v).to.deep.equal({ hello: "w" });
    });
    it("rejects Not Found when the fetch errors", async () => {
      const em = new EventEmitter();
      const a = input({}, {}, em);
      (a as any).volatile = undefined;
      em.on("getVolatile", () => setImmediate(() => fetched(em, "umid1", "i", new Error("x"))));
      let err: any;
      try {
        await a.getVolatile();
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("Volatile Data - Not Found");
    });
    it("rejects Invalid when the fetched data cannot be copied", async () => {
      const em = new EventEmitter();
      const a = input({}, {}, em);
      (a as any).volatile = undefined;
      const cyc: any = {};
      cyc.self = cyc;
      em.on("getVolatile", () => setImmediate(() => fetched(em, "umid1", "i", null, cyc)));
      let err: any;
      try {
        await a.getVolatile();
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("Volatile Data - Invalid");
    });
  });
});
