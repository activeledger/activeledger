import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * A node that voted no because it holds an older revision starts the self
 * repair check (SPI) from its own failure, once. It used to run only when a
 * later frame from a peer happened to arrive after the error was on the entry.
 */
describe("Host.spiFromOwnFailure", () => {
  const real = Endpoints.InternalInitalise;
  let calls: any[];

  const host = (): any =>
    Object.assign(Object.create(Host.prototype), {
      reference: "me",
      host: "10.0.0.1",
      spiStarted: new Map(),
    });
  const entry = (over: any = {}): any => ({
    $umid: "u1",
    $origin: "other",
    $broadcast: true,
    $tx: { $namespace: "n", $contract: "c", $i: {}, $o: {} },
    $nodes: { me: { vote: false, error: "Input Stream Position Incorrect (2-a !== 1-b - Local)" }, other: { vote: true } },
    ...over,
  });

  beforeEach(() => {
    calls = [];
    (Endpoints as any).InternalInitalise = (...args: any[]) => {
      calls.push(args);
      return Promise.resolve({});
    };
  });
  afterEach(() => {
    (Endpoints as any).InternalInitalise = real;
  });

  it("runs the check for a position error on a transaction another node originated", () => {
    const h = host();
    h.spiFromOwnFailure(entry());
    expect(calls).to.have.length(1);
    const [, body, , retried, isP2P] = calls[0];
    expect(body.$umid).to.equal("u1");
    expect(body.$$noreply).to.equal(true); // no reply broadcast
    expect(body.$nodes).to.deep.equal({}); // nothing added to the pending entry
    expect(retried).to.equal(false);
    expect(isP2P).to.equal(true);
  });

  it("runs it for a stream that was not found too", () => {
    host().spiFromOwnFailure(entry({ $nodes: { me: { error: "Stream(s) not found" } } }));
    expect(calls).to.have.length(1);
  });

  it("runs it once for a transaction, however many times the failure is reported", () => {
    const h = host();
    h.spiFromOwnFailure(entry());
    h.spiFromOwnFailure(entry());
    h.spiFromOwnFailure(entry({ $umid: "u2" }));
    expect(calls.map((c) => c[1].$umid)).to.deep.equal(["u1", "u2"]);
  });

  it("does not run for other errors, or no error", () => {
    const h = host();
    h.spiFromOwnFailure(entry({ $nodes: { me: { error: "Vote Failure - Contract rejected" } } }));
    h.spiFromOwnFailure(entry({ $umid: "u3", $nodes: { me: { vote: true } } }));
    h.spiFromOwnFailure(entry({ $umid: "u4", $nodes: {} }));
    expect(calls).to.have.length(0);
  });

  it("does not run for a transaction this node originated (it has its own repair path)", () => {
    host().spiFromOwnFailure(entry({ $origin: "me" }));
    expect(calls).to.have.length(0);
  });

  it("does not run for a transaction that is not a broadcast", () => {
    host().spiFromOwnFailure(entry({ $broadcast: false }));
    expect(calls).to.have.length(0);
  });

  it("does not run for nothing at all", () => {
    host().spiFromOwnFailure(undefined as any);
    expect(calls).to.have.length(0);
  });

  it("forgets old transactions once the list is long, and still runs new ones", () => {
    const h = host();
    const old = Date.now() - 120000;
    for (let i = 0; i < 600; i++) h.spiStarted.set(`old${i}`, old);
    h.spiFromOwnFailure(entry({ $umid: "fresh" }));
    expect(calls).to.have.length(1);
    expect(h.spiStarted.size).to.be.lessThan(10);
  });

  it("a failing check is logged, not thrown", async () => {
    (Endpoints as any).InternalInitalise = () => Promise.reject(new Error("boom"));
    expect(() => host().spiFromOwnFailure(entry())).to.not.throw();
    await new Promise((r) => setTimeout(r, 10));
  });
});
