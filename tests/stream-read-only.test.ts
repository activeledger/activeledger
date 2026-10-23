import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Stream } from "../packages/contracts/src/stream";

// getAnyStreamReadOnly used to add a listener per call and never remove
// it, and to call resolve after reject. A second read of the same stream
// in one transaction then fired the first call's listener again.
describe("Stream.getAnyStreamReadOnly", () => {
  const setup = () => {
    const emitter = new EventEmitter();
    const activity = new Stream(
      new Date(),
      "127.0.0.1",
      "umid-1",
      { $namespace: "ns", $contract: "c" } as any,
      [],
      [],
      {},
      {} as any,
      {},
      1,
      emitter,
      "127.0.0.1"
    );
    // Stand-in for vm.ts: answers asynchronously, like the store read
    let reads = 0;
    emitter.on("getStreamData", (umid: string, id: string) => {
      const n = ++reads;
      setImmediate(() =>
        emitter.emit(
          `getStreamDataFetched-${umid}${id}`,
          id === "bad" ? new Error("missing") : null,
          { _id: id, read: n }
        )
      );
    });
    return { emitter, activity };
  };

  it("resolves with the stream", async () => {
    const { activity } = setup();
    expect(await activity.getAnyStreamReadOnly("cfg")).to.deep.include({ _id: "cfg" });
  });

  it("leaves no listener behind after an answer", async () => {
    const { emitter, activity } = setup();
    await activity.getAnyStreamReadOnly("cfg");
    expect(emitter.listenerCount("getStreamDataFetched-umid-1cfg")).to.equal(0);
  });

  it("gives a repeat read of the same stream its own answer", async () => {
    const { activity } = setup();
    const first: any = await activity.getAnyStreamReadOnly("cfg");
    const second: any = await activity.getAnyStreamReadOnly("cfg");
    expect(first.read).to.equal(1);
    expect(second.read).to.equal(2);
  });

  it("rejects on an error and leaves no listener behind", async () => {
    const { emitter, activity } = setup();
    let failure: any;
    try {
      await activity.getAnyStreamReadOnly("bad");
    } catch (e) {
      failure = e;
    }
    expect(failure.message).to.equal("missing");
    expect(emitter.listenerCount("getStreamDataFetched-umid-1bad")).to.equal(0);
  });
});
