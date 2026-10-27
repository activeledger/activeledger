import { Stream, Activity, validateAdoptShape } from "../packages/contracts/src";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { expect } from "chai";
import { EventEmitter } from "events";
import "mocha";

// The contract side of the hybrid: isSupernode(), the adopt declarations, and
// how the host reads them back.
describe("Hybrid contract API (Activecontracts)", () => {
  const IN = "a".repeat(64);
  const OUT = "b".repeat(64);

  const stream = (supernode?: boolean) => {
    const s = new Stream(
      new Date(),
      "127.0.0.1",
      "umid-api",
      {
        $namespace: "test",
        $contract: "api",
        $i: { owner: { $stream: IN } },
        $o: { [OUT]: {} },
      } as any,
      [
        {
          state: { _id: IN, _rev: "1-a", balance: 1 },
          meta: { _id: IN + ":stream", _rev: "1-b" },
        } as any,
      ],
      [
        {
          state: { _id: OUT, _rev: "1-c" },
          meta: { _id: OUT + ":stream", _rev: "1-d" },
        } as any,
      ],
      {},
      { _id: "", data: {} } as any,
      { [IN]: "sig" } as any,
      0,
      new EventEmitter(),
      "localhost:5259"
    );
    if (supernode !== undefined) s.setHostMode(supernode);
    return s;
  };

  describe("isSupernode", () => {
    it("is true when the host never says otherwise (an older VM)", () => {
      expect(stream().isSupernode()).to.equal(true);
    });

    it("is true on a supernode and false on a hybrid", () => {
      expect(stream(true).isSupernode()).to.equal(true);
      expect(stream(false).isSupernode()).to.equal(false);
    });

    it("marks the execution supernode-dependent when called", () => {
      const s = stream(false);
      expect(s.getSupernodeDependence()).to.deep.equal([]);
      s.isSupernode();
      s.isSupernode();
      expect(s.getSupernodeDependence()).to.deep.equal(["isSupernode"]);
    });

    it("only takes the first host mode", () => {
      const s = stream(false);
      s.setHostMode(true);
      expect(s.isSupernode()).to.equal(false);
    });
  });

  describe("inter-node comms mark the execution supernode-dependent", () => {
    for (const method of [
      "getInterNodeComms",
      "setThisInterNodeComms",
      "clearAllInterNodeComms",
    ]) {
      it(method, () => {
        const s: any = stream(false);
        s[method]({});
        expect(s.getSupernodeDependence()).to.deep.equal([method]);
      });
    }

    it("the VM handing comms in does not", () => {
      const s = stream(false);
      s.setInterNodeComms(0, {});
      expect(s.getSupernodeDependence()).to.deep.equal([]);
    });
  });

  describe("adoptFromSupernode", () => {
    it("does nothing on a supernode", () => {
      const s = stream(true);
      const out = s.getActivityStreams(OUT);
      out.adoptFromSupernode({ signature: "string" });
      expect(s.exportAdoptDeclarations()).to.deep.equal([]);
      expect(out.updated).to.equal(false);
    });

    it("does nothing on a supernode even with an invalid shape", () => {
      const s = stream(true);
      s.getActivityStreams(OUT).adoptFromSupernode({ x: "date" } as any);
      expect(s.exportAdoptDeclarations()).to.deep.equal([]);
    });

    it("records the declaration on a hybrid and marks the stream written", () => {
      const s = stream(false);
      const out = s.getActivityStreams(OUT);
      out.adoptFromSupernode({ signature: "string", broadcastedAt: "number?" });
      expect(s.exportAdoptDeclarations()).to.deep.equal([
        {
          streams: [OUT],
          shape: { signature: "string", broadcastedAt: "number?" },
          atomic: false,
          candidates: false,
        },
      ]);
      expect(out.updated).to.equal(true);
      expect(out.updatedMeta).to.equal(true);
    });

    it("records atomic", () => {
      const s = stream(false);
      s.getActivityStreams(OUT).adoptFromSupernode(
        { a: "string", b: { c: "array" } },
        { atomic: true }
      );
      expect(s.exportAdoptDeclarations()[0].atomic).to.equal(true);
    });

    it("keeps its own copy of the shape", () => {
      const s = stream(false);
      const shape: any = { a: "string" };
      s.getActivityStreams(OUT).adoptFromSupernode(shape);
      shape.b = "number";
      expect(s.exportAdoptDeclarations()[0].shape).to.deep.equal({ a: "string" });
    });

    it("applies to a stream created after the host mode was set", () => {
      const s = stream(false);
      const created = s.newActivityStream("new");
      created.adoptFromSupernode({ address: "string" });
      expect(s.exportAdoptDeclarations()[0].streams).to.deep.equal([
        created.getId(),
      ]);
    });

    it("rejects an invalid shape on a hybrid", () => {
      const out = stream(false).getActivityStreams(OUT);
      expect(() => out.adoptFromSupernode({ a: "date" } as any)).to.throw(
        /unknown type "date"/
      );
      expect(() => out.adoptFromSupernode({})).to.throw(/declares no properties/);
      expect(() => out.adoptFromSupernode([] as any)).to.throw(/must be an object/);
      expect(() => out.adoptFromSupernode({ _id: "string" })).to.throw(
        /_id cannot be declared/
      );
      expect(() => out.adoptFromSupernode({ _rev: "string" })).to.throw(
        /_rev cannot be declared/
      );
      expect(() => out.adoptFromSupernode({ a: { b: "nope" } } as any)).to.throw(
        /a\.b has unknown type/
      );
      expect(() => out.adoptFromSupernode({ a: {} })).to.throw(
        /a declares no properties/
      );
    });
  });

  describe("validateAdoptShape", () => {
    it("accepts every type, optional types and nesting", () => {
      expect(() =>
        validateAdoptShape({
          s: "string",
          n: "number?",
          b: "boolean",
          o: "object?",
          a: "array",
          x: "any?",
          nested: { deeper: { v: "string" }, _id: "string" },
        })
      ).to.not.throw();
    });
  });

  describe("adoptStreamsFromSupernode", () => {
    it("does nothing on a supernode", () => {
      const s: any = stream(true);
      s.adoptStreamsFromSupernode(["not-even-an-input"], { a: "string" });
      expect(s.exportAdoptDeclarations()).to.deep.equal([]);
    });

    it("records $i labels and $o ids as stream ids", () => {
      const s: any = stream(false);
      s.adoptStreamsFromSupernode(["owner", OUT], { balance: "number" }, {
        atomic: true,
      });
      expect(s.exportAdoptDeclarations()).to.deep.equal([
        {
          streams: [IN, OUT],
          shape: { balance: "number" },
          atomic: true,
          candidates: true,
        },
      ]);
    });

    it("accepts the stream id behind a label", () => {
      const s: any = stream(false);
      s.adoptStreamsFromSupernode([IN], { balance: "number" });
      expect(s.exportAdoptDeclarations()[0].streams).to.deep.equal([IN]);
    });

    it("refuses a stream outside $i/$o, so it can never widen what is written", () => {
      const s: any = stream(false);
      expect(() =>
        s.adoptStreamsFromSupernode(["c".repeat(64)], { balance: "number" })
      ).to.throw(/is not an input or output of this transaction/);
      expect(s.exportAdoptDeclarations()).to.deep.equal([]);
    });

    it("refuses an empty list and an invalid shape", () => {
      const s: any = stream(false);
      expect(() => s.adoptStreamsFromSupernode([], { a: "string" })).to.throw(
        /at least one stream/
      );
      expect(() => s.adoptStreamsFromSupernode([OUT], { a: 1 })).to.throw(
        /Invalid adopt shape/
      );
    });

    it("is exported alongside stream declarations", () => {
      const s: any = stream(false);
      s.adoptStreamsFromSupernode([OUT], { a: "string" });
      s.getActivityStreams(IN).adoptFromSupernode({ b: "string" });
      expect(
        s.exportAdoptDeclarations().map((d: any) => d.candidates)
      ).to.deep.equal([true, false]);
    });
  });

  describe("the execution report the host reads", () => {
    it("joins the contract's reasons with the host's and lists declarations", () => {
      const vm = new VirtualMachine("localhost:5259", {} as any, {} as any, {} as any);
      const s = stream(false);
      s.isSupernode();
      s.getActivityStreams(OUT).adoptFromSupernode({ a: "string" });
      (vm as any).smartContracts["umid-report"] = s;
      (vm as any).hostDependence["umid-report"] = ["blocked:https"];

      const report = vm.getExecutionReport("umid-report");
      expect(report.supernodeDependent).to.equal(true);
      expect(report.dependence).to.deep.equal(["blocked:https", "isSupernode"]);
      expect(report.adopt).to.have.length(1);
    });

    it("is empty for an independent execution", () => {
      const vm = new VirtualMachine("localhost:5259", {} as any, {} as any, {} as any);
      (vm as any).smartContracts["umid-plain"] = stream(false);
      expect(vm.getExecutionReport("umid-plain")).to.deep.equal({
        supernodeDependent: false,
        dependence: [],
        adopt: [],
      });
    });
  });
});
