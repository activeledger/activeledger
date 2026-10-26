import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

// Ctrl+C before the node is listening (workers still starting, or the port
// was refused) used to log "Shut Down Initiated" and then carry on: the exit
// was only scheduled when there was a listen socket to close.
describe("Host.shutdown (Activeledger)", () => {
  const realSetTimeout = global.setTimeout;
  const realExit = process.exit;
  let timers: { fn: () => void; ms: number }[];
  let exits: (number | undefined)[];

  beforeEach(() => {
    timers = [];
    exits = [];
    (global as any).setTimeout = (fn: () => void, ms: number) => (timers.push({ fn, ms }), 0 as any);
    (process as any).exit = (code?: number) => void exits.push(code);
  });
  afterEach(() => {
    global.setTimeout = realSetTimeout;
    process.exit = realExit;
  });

  const host = (over: any = {}) => ({ listenSocket: null, shuttingDown: false, api: { close: () => undefined }, ...over });
  const shutdown = (h: any) => (Host as any).prototype.shutdown.call(h);

  it("still exits when it never got as far as listening", () => {
    shutdown(host());
    expect(timers).to.have.length(1);
    timers[0].fn();
    expect(exits).to.deep.equal([0]);
  });

  it("exits even if closing the server throws", () => {
    shutdown(host({ api: { close: () => { throw new Error("not open"); } } }));
    timers[0].fn();
    expect(exits).to.deep.equal([0]);
  });

  it("is one shut down however many times it is asked", () => {
    const h = host();
    shutdown(h);
    shutdown(h);
    expect(timers).to.have.length(1);
  });
});
