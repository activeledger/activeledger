import { Locker } from "../packages/network/src/network/locker";
import { expect } from "chai";
import "mocha";

// Regression coverage for the Locker.cell plain-object -> Map conversion
// (next-perf sweep). No prior test coverage existed for this class at
// all - added alongside the internal storage change since it rewrote
// every method's implementation, even though the public behavior is
// meant to be identical.
describe("Locker (Activenetwork) - next-perf regression", () => {
  // Locker.cell is static/module-level, so tests need distinct stream
  // ids per test to avoid interference between them.
  let counter = 0;
  const streamId = () => `s${counter++}`.padEnd(65, "0");

  it("has() is false for a stream that was never locked", () => {
    expect(Locker.has(streamId())).to.equal(false);
  });

  it("hold() locks a single stream and has()/is() reflect it", () => {
    const s = streamId();
    expect(Locker.hold(s, "umid-a")).to.equal(true);
    expect(Locker.has(s)).to.equal(true);
    expect(Locker.is(s, "umid-a")).to.equal(true);
    expect(Locker.is(s, "umid-b")).to.equal(false);
  });

  it("hold() fails when the stream is already locked by a different umid", () => {
    const s = streamId();
    expect(Locker.hold(s, "umid-a")).to.equal(true);
    expect(Locker.hold(s, "umid-b")).to.equal(false);
  });

  it("release() only releases when the umid matches", () => {
    const s = streamId();
    Locker.hold(s, "umid-a");
    Locker.release(s, "umid-b");
    expect(Locker.has(s)).to.equal(true);
    Locker.release(s, "umid-a");
    expect(Locker.has(s)).to.equal(false);
  });

  it("hold() with an array locks all-or-nothing and rolls back on partial failure", () => {
    const s1 = streamId();
    const s2 = streamId();
    const s3 = streamId();
    Locker.hold(s2, "someone-else");

    expect(Locker.hold([s1, s2, s3], "umid-a")).to.equal(false);
    // s1/s3 should have been rolled back since s2 was already held
    expect(Locker.has(s1)).to.equal(false);
    expect(Locker.has(s3)).to.equal(false);
    // s2's original lock is untouched
    expect(Locker.is(s2, "someone-else")).to.equal(true);
  });

  it("hold() with an array succeeds and locks every stream when all are free", () => {
    const streams = [streamId(), streamId(), streamId()];
    expect(Locker.hold(streams, "umid-a")).to.equal(true);
    for (const s of streams) {
      expect(Locker.is(s, "umid-a")).to.equal(true);
    }
    Locker.release(streams, "umid-a");
    for (const s of streams) {
      expect(Locker.has(s)).to.equal(false);
    }
  });

  it("streams shorter than 60 chars are ignored by the single-stream heuristic", () => {
    expect(Locker.hold("short-label", "umid-a")).to.equal(true);
    expect(Locker.has("short-label")).to.equal(false);
  });

  it("getLocks() returns a plain, JSON.stringify-able object reflecting current locks", () => {
    const s = streamId();
    Locker.hold(s, "umid-a");
    const locks = Locker.getLocks();
    expect(locks[s]).to.deep.include({ umid: "umid-a" });
    // Must survive JSON.stringify the way host.ts's /a/locks endpoint
    // depends on - a Map would serialize to "{}" here instead.
    const serialized = JSON.parse(JSON.stringify(locks));
    expect(serialized[s].umid).to.equal("umid-a");
    Locker.release(s, "umid-a");
  });

  it("checkLocks() auto-releases locks older than the given releaseTime", () => {
    const s = streamId();
    Locker.hold(s, "umid-a");
    // Force the release threshold to 0ms so the just-created lock is
    // immediately "stuck" from checkLocks()'s point of view.
    Locker.checkLocks(0);
    expect(Locker.has(s)).to.equal(false);
  });

  it("checkLocks() leaves fresh locks alone", () => {
    const s = streamId();
    Locker.hold(s, "umid-a");
    Locker.checkLocks(60000);
    expect(Locker.has(s)).to.equal(true);
    Locker.release(s, "umid-a");
  });

  describe("a refused hold of several streams", () => {
    it("takes nothing, and reads no clock, when the first stream looked at is the held one", () => {
      const s1 = streamId();
      const s2 = streamId();
      Locker.hold(s2, "someone-else");
      const realNow = Date.now;
      let reads = 0;
      Date.now = () => (reads++, realNow());
      try {
        // streams are looked at from the last to the first
        expect(Locker.hold([s1, s2], "umid-a")).to.equal(false);
      } finally {
        Date.now = realNow;
      }
      expect(Locker.has(s1)).to.equal(false);
      expect(reads).to.equal(0);
    });

    it("gives back what it took, and leaves another umid's locks alone", () => {
      const [free1, held, free2, other] = [streamId(), streamId(), streamId(), streamId()];
      Locker.hold(held, "someone-else");
      Locker.hold(other, "bystander");
      // looked at last to first: free2 is taken, then held refuses
      expect(Locker.hold([free1, held, free2], "umid-a")).to.equal(false);
      expect(Locker.has(free1)).to.equal(false);
      expect(Locker.has(free2)).to.equal(false);
      expect(Locker.is(held, "someone-else")).to.equal(true);
      expect(Locker.is(other, "bystander")).to.equal(true);
    });

    it("refuses a stream named twice in one request, and takes neither", () => {
      const s = streamId();
      const t = streamId();
      expect(Locker.hold([s, t, s], "umid-a")).to.equal(false);
      expect(Locker.has(s)).to.equal(false);
      expect(Locker.has(t)).to.equal(false);
    });

    it("can be taken afterwards by the umid that was waiting", () => {
      const s1 = streamId();
      const s2 = streamId();
      Locker.hold(s2, "someone-else");
      expect(Locker.hold([s1, s2], "umid-a")).to.equal(false);
      Locker.release(s2, "someone-else");
      expect(Locker.hold([s1, s2], "umid-a")).to.equal(true);
      expect(Locker.is(s1, "umid-a") && Locker.is(s2, "umid-a")).to.equal(true);
    });
  });

  it("a hold of several streams gives them one shared time, so the stuck-lock check sees them together", () => {
    const streams = [streamId(), streamId(), streamId()];
    Locker.hold(streams, "umid-shared");
    const locks = Locker.getLocks();
    expect(new Set(streams.map((s) => locks[s].time)).size).to.equal(1);
    Locker.release(streams, "umid-shared");
  });

  it("ignores streams of 60 characters or fewer, which are labels", () => {
    expect(Locker.hold(["label", "another"], "umid-a")).to.equal(true);
    expect(Locker.has("label")).to.equal(false);
    expect(Locker.hold(["label"], "umid-b")).to.equal(true);
  });
});
