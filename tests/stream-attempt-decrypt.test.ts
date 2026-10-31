import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Stream } from "../packages/contracts/src/stream";

// attemptDecrypt used to call a static Secured.decrypt that does not exist,
// so it always failed with an accidental TypeError.
describe("Stream.attemptDecrypt", () => {
  it("rejects with a clear deprecation error", async () => {
    const stream = new Stream(
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
      new EventEmitter(),
      "127.0.0.1"
    );
    let caught: any;
    try {
      await stream.attemptDecrypt({});
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught).to.not.be.instanceOf(TypeError);
    expect(caught.message).to.equal(
      "attemptDecrypt is deprecated and no longer supported"
    );
  });
});
