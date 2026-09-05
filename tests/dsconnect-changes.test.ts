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

  it("a null body neither throws nor ends the feed", async () => {
    sendImpl = async () => ({ data: null });
    const changes = new ActiveDSChanges({ since: 0 }, "http://store/db/_changes");
    const errors: unknown[] = [];
    changes.on("error", (e: unknown) => errors.push(e));
    try {
      await settle(1600);
      expect(errors.map(String).join(","), "a null body is an ordinary empty round").to.equal("");
      expect(calls, "feed must keep polling").to.be.greaterThan(1);
      // Backs off rather than re-arming instantly - an immediate retry here
      // busy-loops, because a body-less response returns straight away
      // instead of blocking like a healthy longpoll.
      expect(calls, "feed must back off, not spin").to.be.lessThan(20);
    } finally {
      changes.cancel();
    }
  });

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
