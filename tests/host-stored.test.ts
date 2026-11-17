import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

const MIN = 60 * 1000;
const A = "a".repeat(64);
const B = "b".repeat(64);

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
      storedByMinute: new Map(),
      storedCount: 0,
      storedUnknown: new Set(),
      storedUnknownAllUntil: 0,
      storedColdUntil: 0,
      storedSwept: 0,
      storedMarkerLoaded: true,
      storedMarkerWritten: new Set(),
      dbEventConnection: { post: async (d: any) => (posted.push(d), {}) },
      ...over,
    });
    return host as Host & any;
  };
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ms = (m: number) => Date.now() + m;

  it("says no for an umid it never saw, once it has been running longer than the window", () => {
    expect(make().mayBeStored(A, ms(MIN))).to.equal(false);
  });

  it("says maybe for an umid it committed, no for another with the same $expire", () => {
    const host = make();
    const expire = at(MIN);
    host.noteStored(A, expire);
    expect(host.mayBeStored(A, new Date(expire).getTime())).to.equal(true);
    expect(host.mayBeStored(B, new Date(expire).getTime())).to.equal(false);
  });

  it("says maybe for everything just after a start", () => {
    expect(make({ storedColdUntil: ms(1000) }).mayBeStored(A, ms(MIN))).to.equal(true);
  });

  it("asks the storage for an $expire beyond the window, holds no umid for it, and says maybe only for its own minute once it is near", () => {
    const host = make();
    const far = ms(60 * MIN);
    host.noteStored(A, new Date(far).toISOString());
    expect(host.storedCount).to.equal(0);
    expect(host.mayBeStored(A, far)).to.equal(true);
    // The same bytes, an hour on and now inside the window: still looked up
    const m = Math.floor(far / MIN);
    expect(host.storedUnknown.has(m)).to.equal(true);
    // another $expire is not affected by it
    expect(host.mayBeStored(B, ms(MIN))).to.equal(false);
  });

  it("writes one row for a minute however many far-off commits land in it", () => {
    const host = make();
    host.noteStored(A, at(60 * MIN));
    host.noteStored(B, at(60 * MIN + 100));
    expect(posted.length).to.be.lessThan(3);
    const ids = new Set(posted.map((p) => p._id));
    expect(ids.size).to.equal(posted.length);
    expect(posted[0]._id).to.match(/^storedfar:\d+$/);
  });

  it("ignores a transaction with no $expire or one that has passed", () => {
    const host = make();
    host.noteStored(A, undefined);
    host.noteStored(B, at(-MIN));
    expect(host.storedCount).to.equal(0);
    expect(host.storedUnknown.size).to.equal(0);
  });

  it("drops a minute that has passed", () => {
    const host = make();
    host.storedByMinute.set(Math.floor(Date.now() / MIN) - 5, new Set(["old"]));
    host.storedCount = 1;
    host.noteStored(A, at(MIN));
    expect(host.storedByMinute.has(Math.floor(Date.now() / MIN) - 5)).to.equal(false);
    expect(host.storedCount).to.equal(1);
  });

  it("notes the minute instead of holding the umid past the most it will hold", () => {
    const host = make({ storedCount: 200000 });
    const expire = at(MIN);
    host.noteStored(A, expire);
    expect(host.storedCount).to.equal(200000);
    expect(host.mayBeStored(B, new Date(expire).getTime())).to.equal(true);
    expect(host.mayBeStored(B, ms(3 * MIN))).to.equal(false);
  });

  it("says maybe to everything when too many minutes are noted, until the latest passes", () => {
    const host = make({ storedUnknown: new Set(Array.from({ length: 10000 }, (_, i) => i)) });
    host.noteStored(A, at(60 * MIN));
    expect(host.storedUnknownAllUntil).to.be.greaterThan(Date.now());
    // and a restart reads it from disk: the minute still got its row
    expect(posted.some((d) => /^storedfar:\d+$/.test(d._id))).to.equal(true);
    expect(host.mayBeStored(B, ms(MIN))).to.equal(true);
  });

  it("says maybe until the rows have been read, then for the minutes they name", async () => {
    const minute = Math.floor((Date.now() + 3 * MIN) / MIN);
    const host = make({
      storedMarkerLoaded: false,
      storedMarkerTried: 0,
      dbEventConnection: {
        allDocs: async () => ({
          rows: [
            { _id: `storedfar:${minute}`, minute, until: (minute + 1) * MIN },
            { _id: "storedfar:1", minute: 1, until: 60000 },
          ],
        }),
        purge: async () => ({}),
      },
    });
    expect(host.mayBeStored(A, ms(MIN))).to.equal(true);
    await host.loadStoredMarker();
    expect(host.storedMarkerLoaded).to.equal(true);
    expect(host.storedUnknown.has(minute)).to.equal(true);
    expect(host.storedUnknown.has(1)).to.equal(false);
    expect(host.mayBeStored(A, minute * MIN + 1)).to.equal(true);
    expect(host.mayBeStored(A, ms(MIN))).to.equal(false);
  });

  it("keeps saying maybe when the rows cannot be read", async () => {
    const host = make({ storedMarkerLoaded: false, storedMarkerTried: 0, dbEventConnection: { allDocs: async () => { throw new Error("down"); } } });
    await host.loadStoredMarker();
    expect(host.storedMarkerLoaded).to.equal(false);
    expect(host.mayBeStored(A, ms(MIN))).to.equal(true);
  });
});
