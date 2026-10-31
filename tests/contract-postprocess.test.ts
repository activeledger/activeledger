import { ActiveLogger } from "../packages/logger/src";
import { ActiveCrypto } from "../packages/crypto/src";

// Setup VM Global variables
Object.defineProperty(global, "crypto", {
  value: ActiveCrypto,
  configurable: true,
});
Object.defineProperty(global, "logger", {
  value: ActiveLogger,
  configurable: true,
});

import {
  Event,
  PostProcess,
  PostProcessEvent,
  Standard,
  Stream,
} from "../packages/contracts/src";
import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";

// PostProcess and PostProcessEvent are the base classes for contracts that run
// code after the commit phase. The VM never calls them by type: it asks the
// contract instance whether it has a "postProcess" or "setEvent" member, so
// what these classes provide (and what a plain contract must not) is the
// contract with the VM.
describe("PostProcess contract base classes (Activecontracts)", () => {
  // The smallest Stream a contract can be constructed over
  const newStream = (ctor: any): any =>
    new ctor(
      new Date(),
      "::1",
      "umid",
      { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
      [],
      [],
      { _id: "", data: {} },
      { _id: "", data: {} },
      {},
      1234,
      new EventEmitter(),
      "localhost"
    );

  class Plain extends Standard {
    public async vote() {
      return true;
    }
    public async commit() {
      return true;
    }
  }

  class Post extends PostProcess {
    public calls: [boolean, string][] = [];
    public async vote() {
      return true;
    }
    public async commit() {
      return true;
    }
    public async postProcess(territoriality: boolean, who: string) {
      this.calls.push([territoriality, who]);
      return { territoriality, who };
    }
  }

  class PostEvent extends PostProcessEvent {
    public async vote() {
      return true;
    }
    public async commit() {
      return true;
    }
    public async postProcess(territoriality: boolean, who: string) {
      // Uses the engine the VM injected
      return (this.event as any).tag + (territoriality ? ":first" : ":other") + who;
    }
  }

  describe("PostProcess", () => {
    it("is a Standard contract and a Stream", () => {
      const c = newStream(Post);
      expect(c).to.be.instanceOf(PostProcess);
      expect(c).to.be.instanceOf(Standard);
      expect(c).to.be.instanceOf(Stream);
    });

    it("runs the contract's postProcess with the territoriality and node", async () => {
      const c = newStream(Post);
      expect(await c.postProcess(true, "node-a")).to.deep.equal({
        territoriality: true,
        who: "node-a",
      });
      await c.postProcess(false, "node-b");
      expect(c.calls).to.deep.equal([
        [true, "node-a"],
        [false, "node-b"],
      ]);
    });

    it("is found by the VM's `in` check, which a plain contract fails", () => {
      expect("postProcess" in newStream(Post)).to.equal(true);
      expect("postProcess" in newStream(Plain)).to.equal(false);
    });

    it("has no event hook, so the VM does not inject an engine", () => {
      expect("setEvent" in newStream(Post)).to.equal(false);
    });
  });

  describe("PostProcessEvent", () => {
    it("is a PostProcess contract", () => {
      const c = newStream(PostEvent);
      expect(c).to.be.instanceOf(PostProcessEvent);
      expect(c).to.be.instanceOf(PostProcess);
      expect(c).to.be.instanceOf(Standard);
    });

    it("is found by the VM's `in` checks for both hooks", () => {
      const c = newStream(PostEvent);
      expect("postProcess" in c).to.equal(true);
      expect("setEvent" in c).to.equal(true);
    });

    it("gives postProcess the event engine the VM sets", async () => {
      const c = newStream(PostEvent);
      c.setEvent({ tag: "engine" });
      expect(await c.postProcess(true, "n1")).to.equal("engine:firstn1");
      expect(await c.postProcess(false, "n2")).to.equal("engine:othern2");
    });

    it("keeps the engine per contract instance", async () => {
      const a = newStream(PostEvent);
      const b = newStream(PostEvent);
      a.setEvent({ tag: "a" });
      b.setEvent({ tag: "b" });
      expect(await a.postProcess(true, "")).to.equal("a:first");
      expect(await b.postProcess(true, "")).to.equal("b:first");
    });

    it("replaces the engine when it is set again", async () => {
      const c = newStream(PostEvent);
      c.setEvent({ tag: "old" });
      c.setEvent({ tag: "new" });
      expect(await c.postProcess(true, "")).to.equal("new:first");
    });

    it("has the same event hook as the Event base class", () => {
      class Ev extends Event {
        public async vote() {
          return true;
        }
        public async commit() {
          return true;
        }
      }
      const engine: any = {};
      const e: any = newStream(Ev);
      const p: any = newStream(PostEvent);
      e.setEvent(engine);
      p.setEvent(engine);
      expect(e.event).to.equal(engine);
      expect(p.event).to.equal(engine);
    });
  });
});
