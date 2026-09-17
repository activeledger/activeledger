import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";

// Re-adding a public key that is already an authority has to UPDATE it.
// It used to keep the original and drop the new entry, while still
// setting updatedMeta - so the transaction committed, reported success,
// and changed nothing. That is the failure shape this codebase produces
// most often, and it makes key renewal impossible.
describe("Re-adding an existing authority (Activecontracts)", () => {
  const PUB = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
  const OTHER = "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----";

  const activity = () => {
    const meta: any = { _id: "s:stream", _rev: "1-a" };
    const state: any = { _id: "s", _rev: "1-a" };
    // signature=true selects the input-stream path setAuthorities needs
    return new Activity("umid-seed", null, true, new EventEmitter(), meta, state);
  };

  // OTHER is present and permanent throughout the expire-related cases:
  // a stream must always keep one key with no expire, so renewing PUB
  // into an expiring key is only legal while something else can still
  // sign. See authority-forever-guard.test.ts for that rule itself.
  it("applies an expire added to an existing key", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100 },
    ] as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100, expire: "2027-01-01T00:00:00.000Z" } as any);

    const authorities: any[] = a.getAuthorities();
    expect(authorities).to.have.length(2);
    const renewed = authorities.find((x) => x.public === PUB);
    expect(renewed.expire).to.equal("2027-01-01T00:00:00.000Z");
  });

  it("applies a changed stake to an existing key", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 50 } as any);

    const authorities: any[] = a.getAuthorities();
    expect(authorities).to.have.length(1);
    expect(authorities[0].stake).to.equal(50);
  });

  // Promotion back to a permanent key - the other half of renewal.
  it("removes an expire when the key is re-added without one", () => {
    const a = activity();
    a.setAuthorities([
      { public: OTHER, type: "rsa", stake: 100 },
      { public: PUB, type: "rsa", stake: 100, expire: "2027-01-01T00:00:00.000Z" },
    ] as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);

    const authorities: any[] = a.getAuthorities();
    expect(authorities).to.have.length(2);
    const promoted = authorities.find((x) => x.public === PUB);
    expect(promoted.expire).to.equal(undefined);
  });

  it("still enforces one entry per public key", () => {
    const a = activity();
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 100 } as any);
    expect(a.getAuthorities()).to.have.length(1);
  });

  it("leaves other authorities alone", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100 },
    ] as any);
    a.setAuthorities({ public: PUB, type: "rsa", stake: 25 } as any);

    const authorities: any[] = a.getAuthorities();
    expect(authorities).to.have.length(2);
    const other = authorities.find((x) => x.public === OTHER);
    expect(other.stake).to.equal(100);
  });

  it("accepts several distinct keys at once", () => {
    const a = activity();
    a.setAuthorities([
      { public: PUB, type: "rsa", stake: 100 },
      { public: OTHER, type: "rsa", stake: 100 },
    ] as any);
    expect(a.getAuthorities()).to.have.length(2);
  });
});
