import { expect } from "chai";
import "mocha";

// The class captures ActiveRequest at module scope, and TypeScript's commonjs
// emit resolves it per call (activeutilities_1.ActiveRequest.send), so
// replacing send() on the required module object is enough - as long as it
// happens before any round runs.
// Resolved relative to packages/options rather than the repo root: this is a
// lerna monorepo, so @activeledger/* are linked per-package and are not
// resolvable from tests/ itself. dsconnect.ts resolves it from its own
// location, which is the same module instance this replaces send() on.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activeutilities = require(require.resolve("@activeledger/activeutilities", {
  paths: [__dirname + "/../packages/options"],
}));
const realSend = activeutilities.ActiveRequest.send;

import { ActiveDSChanges } from "../packages/options/src/dsconnect";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Regression coverage for a changes feed that could stop forever without
 * reporting anything.
 *
 * `response.data.results` was read unguarded while the `last_seq` read one
 * line above already allowed for a null body. A body-less longpoll round
 * therefore threw inside the .then(), landed in the .catch(), and nothing
 * re-armed listen() - so a single empty response permanently ended the feed.
 *
 * Live-confirmed downstream before this fix: a nano-gateway subscriber took
 * "Cannot read properties of null (reading 'results')" and never received
 * another change, while its own SSE socket stayed open and heartbeating, so
 * no component anywhere reported a fault.
 */
describe("ActiveDSChanges - the changes feed must survive a bad round", () => {
  let calls = 0;
  let sendImpl: () => Promise<unknown> = async () => ({ data: { results: [], last_seq: 1 } });

  beforeEach(() => {
    calls = 0;
    activeutilities.ActiveRequest.send = async () => {
      calls++;
      return sendImpl();
    };
  });

  after(() => {
    activeutilities.ActiveRequest.send = realSend;
  });

  it("a null body is REPORTED as a failure, and the feed backs off rather than spinning", async () => {
    // The original version of this test asserted a null body emits no error,
    // "because it is an ordinary empty round". That was wrong, and the mistake
    // mattered: ActiveRequest.send() never rejects - it returns { data: null }
    // for connection-refused, DNS failure, bodyTimeout, socket reset, non-2xx
    // and unparseable body alike. So a null body is the ONLY way a transport
    // fault can present, and treating it as routine meant a completely dead
    // datastore was indistinguishable from a quiet one, forever, in silence.
    sendImpl = async () => ({ data: null });
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    const errors: unknown[] = [];
    changes.on("error", (e: unknown) => errors.push(e));
    try {
      await settle(1600);
      expect(errors.length, "a consumer must be able to learn the feed is failing").to.be.greaterThan(0);
      expect(calls, "feed must keep polling").to.be.greaterThan(1);
      // Backs off rather than re-arming instantly - a body-less response
      // returns straight away instead of blocking like a healthy longpoll.
      expect(calls, "feed must back off, not spin").to.be.lessThan(20);
    } finally {
      changes.cancel();
    }
  });

  it("emitting an error with no listener attached does not crash the feed", async () => {
    // Node throws on an "error" event with no listener. The null-body path is
    // now genuinely reachable on every datastore blip, so an unguarded emit
    // would turn a transient outage into a crash in every consumer that never
    // needed an error handler.
    sendImpl = async () => ({ data: null });
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    try {
      await settle(600);
      expect(calls, "feed must still be polling").to.be.greaterThan(0);
    } finally {
      changes.cancel();
    }
  });

  it("a body with no results array backs off instead of hot-looping", async () => {
    // httpd's error path responds with JSON.stringify(new Error(...)), which
    // is the literal string "{}" - truthy, parses fine, no results array. The
    // continuation at the bottom of listen() re-arms IMMEDIATELY, which is
    // safe only because a healthy longpoll blocks. A body like this returns
    // instantly, so it pegged both ends at full request rate with nothing
    // visible to the consumer. Guarding `results` against a throw stopped the
    // crash and left the spin.
    sendImpl = async () => ({ data: {} });
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    const errors: unknown[] = [];
    changes.on("error", (e: unknown) => errors.push(e));
    try {
      await settle(1600);
      expect(errors.length, "a malformed round must be reported").to.be.greaterThan(0);
      expect(calls, "must NOT hot-loop").to.be.lessThan(20);
    } finally {
      changes.cancel();
    }
  });

  it("cancel() then restart() with a round in flight does not leave two loops running", async () => {
    // cancel() cannot abort the in-flight request - ActiveRequest exposes no
    // abort handle - so the cancelled round resolves later. It re-checked only
    // `stop`, which restart() has since set back to false, and re-armed. Two
    // loops against one feed, permanently, both advancing `since` and emitting
    // every change twice. ActiveChanges.pause() then start() is exactly this.
    let inFlight = 0;
    let maxInFlight = 0;
    sendImpl = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await settle(200);
      inFlight--;
      return { data: { results: [], last_seq: 1 } };
    };
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    changes.on("error", () => undefined);
    try {
      await settle(100); // a round is now in flight
      changes.cancel();
      changes.restart();

      // A BRIEF overlap of two requests is unavoidable and harmless: cancel()
      // cannot abort the round already on the wire, so it stays in flight
      // until it resolves and is then disowned. What must not happen is two
      // loops PERSISTING. So let the orphan drain first, then measure.
      await settle(400);
      maxInFlight = inFlight;
      await settle(900);

      expect(maxInFlight, "after the orphaned round drains, only one loop may remain").to.equal(1);
    } finally {
      changes.cancel();
    }
  });

  // Kept as backstop coverage, but note ActiveRequest.send() cannot actually
  // produce this: it swallows every transport fault into { data: null } (see
  // the first test). What this exercises is the catch path for a genuine bug
  // in the handling code, not for a datastore being down.
  it("a rejected round is reported and then retried, not fatal", async () => {
    sendImpl = async () => {
      throw new Error("datastore restarting");
    };
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    const errors: unknown[] = [];
    changes.on("error", (e: unknown) => errors.push(e));
    try {
      await settle(1600);
      expect(errors.length, "the failure should still surface").to.be.greaterThan(0);
      expect(calls, "feed must retry after a failure").to.be.greaterThan(1);
    } finally {
      changes.cancel();
    }
  });

  it("still emits ordinary changes one at a time", async () => {
    // Delayed deliberately: a healthy round continues immediately (unchanged
    // behaviour), which assumes the server is genuinely long-polling.
    sendImpl = async () => {
      await settle(50);
      return { data: { results: [{ doc: { _id: "a" }, seq: 7 }], last_seq: 7 } };
    };
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    const seen: Array<{ doc: { _id: string }; seq: number }> = [];
    changes.on("change", (c: { doc: { _id: string }; seq: number }) => seen.push(c));
    try {
      await settle(500);
      expect(seen.length).to.be.greaterThan(0);
      expect(seen[0].doc._id).to.equal("a");
      expect(seen[0].seq).to.equal(7);
    } finally {
      changes.cancel();
    }
  });

  it("cancel() stops the feed and clears a pending retry", async () => {
    sendImpl = async () => {
      throw new Error("down");
    };
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    changes.on("error", () => undefined);
    await settle(400);
    changes.cancel();
    const after = calls;
    await settle(1400);
    expect(calls, "no further requests after cancel()").to.equal(after);
  });
});
