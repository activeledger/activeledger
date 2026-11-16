import { expect } from "chai";
import "mocha";
import { isCloneError, jsonCopy, withJsonFallback } from "../packages/network/src/network/ipc";

describe("IPC helpers (Activenetwork)", () => {
  describe("isCloneError", () => {
    it("recognises a failed clone by name or by message, and nothing else", () => {
      const byName = Object.assign(new Error("x"), { name: "DataCloneError" });
      expect(isCloneError(byName)).to.equal(true);
      expect(isCloneError(new Error("() => {} could not be cloned."))).to.equal(true);
      for (const other of [new Error("channel closed"), new TypeError("circular"), undefined, null, "could not be cloned"]) {
        expect(isCloneError(other), String(other)).to.equal(false);
      }
    });
  });

  describe("jsonCopy", () => {
    it("is the message as JSON carries it: functions and undefined left behind, dates as text", () => {
      const out: any = jsonCopy({ keep: 1, fn: () => 1, gone: undefined, when: new Date(0), nested: { f() {}, ok: [1, undefined] } });
      expect(out).to.deep.equal({ keep: 1, when: "1970-01-01T00:00:00.000Z", nested: { ok: [1, null] } });
    });
  });

  describe("withJsonFallback", () => {
    const cloneFailure = () => Object.assign(new Error("could not be cloned"), { name: "DataCloneError" });

    it("sends a message that clones as it is", () => {
      const sent: any[] = [];
      const child: any = { send: (...a: any[]) => (sent.push(a), true) };
      withJsonFallback(child);
      const msg = { type: "t", data: { when: new Date(0) } };
      expect(child.send(msg, "cb")).to.equal(true);
      expect(sent).to.have.length(1);
      expect(sent[0][0]).to.equal(msg);
      expect(sent[0][1]).to.equal("cb");
    });

    it("sends a message that cannot be cloned as JSON would, with its other arguments", () => {
      const sent: any[] = [];
      const child: any = {
        send: (m: any, ...rest: any[]) => {
          if (typeof m.data.fn === "function") throw cloneFailure();
          sent.push([m, ...rest]);
          return true;
        },
      };
      withJsonFallback(child);
      expect(child.send({ type: "setup", data: { fn: () => 1, a: 1 } }, "cb")).to.equal(true);
      expect(sent).to.deep.equal([[{ type: "setup", data: { a: 1 } }, "cb"]]);
    });

    it("leaves every other failure to the caller", () => {
      const child: any = { send: () => { throw new Error("channel closed"); } };
      withJsonFallback(child);
      expect(() => child.send({ type: "t" })).to.throw("channel closed");
    });
  });
});
