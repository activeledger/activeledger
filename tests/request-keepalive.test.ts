import {
  DISPATCHER_OPTIONS,
  SERVER_IDLE_TIMEOUT_MS,
} from "../packages/utilities/src/request";
import { expect } from "chai";
import "mocha";

// These assert a RELATIONSHIP, not a number. The bug was never that 30s
// was wrong in isolation - it was that nobody wrote down what it had to be
// smaller than, so raising it looked like a free performance win.
//
// A client keep-alive longer than the server's idle timeout means the
// client hands requests to sockets the server has already closed. undici
// does not retry non-idempotent requests, so writes fail and reads do not:
// a stream write is a POST to _bulk_docs, and it surfaced as intermittent
// 1510 "Failed to save streams" with nothing in the server's log, taking
// nodes out of consensus rounds.
describe("ActiveRequest dispatcher keep-alive (Activeutilities)", () => {
  it("expires an idle connection before the server does", () => {
    expect(DISPATCHER_OPTIONS.keepAliveTimeout).to.be.lessThan(
      SERVER_IDLE_TIMEOUT_MS
    );
  });

  it("leaves real margin, not a boundary", () => {
    // The server sweeps its timeout on a timer rather than to the
    // millisecond, so "just under" is not under
    expect(SERVER_IDLE_TIMEOUT_MS - DISPATCHER_OPTIONS.keepAliveTimeout).to.be.at.least(
      2_000
    );
  });

  it("caps the ceiling too, so a server hint cannot re-raise it", () => {
    // undici honours a server's "Keep-Alive: timeout=N" up to
    // keepAliveMaxTimeout, which defaults to 600s
    expect(DISPATCHER_OPTIONS.keepAliveMaxTimeout).to.be.lessThan(
      SERVER_IDLE_TIMEOUT_MS
    );
  });

  it("still reuses connections rather than disabling keep-alive", () => {
    // The point is a safe window, not no window - tearing down every
    // socket would reintroduce the handshake cost 16d3a9f was avoiding
    expect(DISPATCHER_OPTIONS.keepAliveTimeout).to.be.greaterThan(0);
  });
});
