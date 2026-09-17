import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";

// A stream whose every key carries an expire becomes permanently
// unusable the day the last one passes - and nothing can sign the
// transaction that would fix it, because fixing it needs a signature.
// So at least one authority must have no expire at all.
describe("At least one permanent authority (Activecontracts)", () => {
  const PUB = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
  const OTHER = "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----";
  const FUTURE = "2099-01-01T00:00:00.000Z";

  const activity = () => {
    const meta: any = { _id: "s:stream", _rev: "1-a" };
    const state: any = { _id: "s", _rev: "1-a" };
    return new Activity("umid-seed", null, true, new EventEmitter(), meta, state);
  };

  it("refuses to put an expire on the only authority", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    expect(() =>
      a.setAuthorities({ public: PUB, type: "rsa", stake: 100, expire: FUTURE } as any)
    ).to.throw(/expire every authority/);
  });

  it("allows an expiring key alongside a permanent one", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    expect(() =>
      a.setAuthorities({ public: OTHER, type: "rsa", stake: 100, expire: FUTURE } as any)
    ).to.not.throw();
    expect(a.getAuthorities()).to.have.length(2);
  });

  it("refuses to delete the last permanent key", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100, expire: FUTURE },
    ] as any);
    expect(() => a.deleteAuthorities(PUB)).to.throw(/expire every authority/);
  });

  it("allows deleting an expiring key", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100, expire: FUTURE },
    ] as any);
    expect(() => a.deleteAuthorities(OTHER)).to.not.throw();
    expect(a.getAuthorities()).to.have.length(1);
  });

  // A distant expire is still an expire. If this were allowed the stream
  // would simply die later instead of now.
  it("refuses a far-future expire on the only authority", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    expect(() =>
      a.setAuthorities({ public: PUB, type: "rsa", stake: 100, expire: "2999-01-01T00:00:00.000Z" } as any)
    ).to.throw(/expire every authority/);
  });

  // Promotion must stay possible, or a stream with one expiring key
  // could never be repaired.
  it("allows removing an expire to restore a permanent key", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100, expire: FUTURE },
    ] as any);
    expect(() =>
      a.setAuthorities({ public: OTHER, type: "rsa", stake: 100 } as any)
    ).to.not.throw();
  });

  it("leaves the authorities untouched when it throws", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    try {
      a.setAuthorities({ public: PUB, type: "rsa", stake: 100, expire: FUTURE } as any);
    } catch {
      // expected
    }
    expect((a.getAuthorities()[0] as any).expire).to.equal(undefined);
  });
});
