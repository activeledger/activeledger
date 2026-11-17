import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

const MIN = 60 * 1000;

/**
 * A transaction with an $expire is asked about "already committed?" on every
 * submit. Memory answers it when it can know, the storage is asked when it can not.
 */
describe("Host - committed umids held until their $expire (Activenetwork)", () => {
  const posted: any[] = [];
  beforeEach(() => (posted.length = 0));
  const make = (over: any = {}) => {
    const host: any = Object.create(Host.prototype);
    Object.assign(host, {
      storedLive: new Map(),
      storedUntrackedUntil: 0,
      storedColdUntil: 0,
      storedMarkerLoaded: true,
      storedMarkerWritten: 0,
      dbEventConnection: { post: async (d: any) => (posted.push(d), {}) },
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

  it("writes one row for a far-off commit and none for the next one under it", () => {
    const host = make();
    host.noteStored("a".repeat(64), at(60 * MIN));
    host.noteStored("b".repeat(64), at(61 * MIN));
    expect(posted.length).to.equal(1);
    expect(posted[0]._id).to.match(/^storedfar:\d+$/);
  });

  it("says maybe until the marker has been read, then uses it", async () => {
    const until = Date.now() + 30 * MIN;
    const host = make({
      storedMarkerLoaded: false,
      storedMarkerTried: 0,
      dbEventConnection: {
        allDocs: async () => ({ rows: [{ _id: `storedfar:${until}`, until }, { _id: "storedfar:1", until: 1 }] }),
        purge: async () => ({}),
      },
    });
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
    await host.loadStoredMarker();
    expect(host.storedMarkerLoaded).to.equal(true);
    expect(host.storedUntrackedUntil).to.equal(until);
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
  });

  it("keeps saying maybe when the marker cannot be read", async () => {
    const host = make({ storedMarkerLoaded: false, storedMarkerTried: 0, dbEventConnection: { allDocs: async () => { throw new Error("down"); } } });
    await host.loadStoredMarker();
    expect(host.storedMarkerLoaded).to.equal(false);
    expect(host.mayBeStored("a".repeat(64), Date.now() + MIN)).to.equal(true);
  });
});
