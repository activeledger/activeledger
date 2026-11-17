import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

const MIN = 60 * 1000;

/**
 * A transaction with an $expire is asked about "already committed?" on every
 * submit. Memory answers it when it can know, the storage is asked when it can not.
 */
describe("Host - committed umids held until their $expire (Activenetwork)", () => {
  const make = (over: any = {}) => {
    const host: any = Object.create(Host.prototype);
    Object.assign(host, {
      storedLive: new Map(),
      storedUntrackedUntil: 0,
      storedColdUntil: 0,
      storedSwept: 0,
      ...over,
    });
    return host as Host & any;
  };
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("says no for an umid it never saw, once it has been running longer than the window", () => {
    expect(make().mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(false);
  });

  it("says maybe for an umid it committed", () => {
    const host = make();
    host.noteStored("a".repeat(64), at(MIN));
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
    expect(host.mayBeStored("b".repeat(64), Date.now() + MIN)).to.equal(false);
  });

  it("says maybe for everything just after a start", () => {
    const host = make({ storedColdUntil: Date.now() + 1000 });
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
  });

  it("asks the storage for an $expire beyond the window, and holds nothing for it", () => {
    const host = make();
    host.noteStored("a".repeat(64), at(60 * MIN));
    expect(host.storedLive.size).to.equal(0);
    // a repost close to its expiry is now inside the window but was never held
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
    expect(host.mayBeStored("a".repeat(64), Date.now() + 60 * MIN)).to.equal(true);
  });

  it("says no again once the commit it could not hold has expired", () => {
    const host = make({ storedUntrackedUntil: Date.now() - 1 });
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(false);
  });

  it("ignores a transaction with no $expire or one that has passed", () => {
    const host = make();
    host.noteStored("a".repeat(64), undefined);
    host.noteStored("b".repeat(64), at(-MIN));
    expect(host.storedLive.size).to.equal(0);
    expect(host.storedUntrackedUntil).to.equal(0);
  });

  it("forgets an umid after its $expire", () => {
    const host = make();
    host.storedLive.set("old", Date.now() - 1);
    host.noteStored("a".repeat(64), at(MIN));
    expect(host.storedLive.has("old")).to.equal(false);
    expect(host.storedLive.size).to.equal(1);
  });

  it("stops holding past the most it will hold and asks the storage for the rest", () => {
    const host = make();
    for (let i = 0; i < 200000; i++) host.storedLive.set(String(i), Date.now() + MIN);
    host.noteStored("a".repeat(64), at(MIN));
    expect(host.storedLive.size).to.equal(200000);
    expect(host.mayBeStored("b".repeat(64), Date.now() + MIN)).to.equal(true);
  });
});
