import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ReadLock } from "../packages/protocol/src/protocol/readlock";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { Activity } from "../packages/contracts/src/stream";
import { EventEmitter } from "events";

const withBuild = async (build: number, fn: () => Promise<void> | void) => {
  const before = ActiveOptions.get<number>("build", 0);
  ActiveOptions.set("build", build);
  try {
    await fn();
  } finally {
    ActiveOptions.set("build", before);
  }
};

describe("ReadLock (Activeprotocol)", () => {
  describe("split", () => {
    it("names the stream and the part of a document id", () => {
      expect(ReadLock.split("abc")).to.deep.equal({ stream: "abc", part: "state" });
      expect(ReadLock.split("abc:stream")).to.deep.equal({ stream: "abc", part: "stream" });
      expect(ReadLock.split("abc:volatile")).to.deep.equal({ stream: "abc", part: "volatile" });
      expect(ReadLock.split("abc:umid")).to.deep.equal({ stream: "abc", part: "state" });
    });
  });

  describe("allowed", () => {
    const meta = (readLock?: any): any => ({ ns: "owner", readLock });

    it("allows everything when the stream has no lock", () => {
      for (const part of ["state", "stream", "volatile"] as const) {
        expect(ReadLock.allowed(meta(), part, "other")).to.equal(true);
      }
    });

    it("defaults to state and stream open, volatile to the creator only", () => {
      const m = meta({});
      expect(ReadLock.allowed(m, "state", "other")).to.equal(true);
      expect(ReadLock.allowed(m, "stream", "other")).to.equal(true);
      expect(ReadLock.allowed(m, "volatile", "other")).to.equal(false);
      expect(ReadLock.allowed(m, "volatile", "owner")).to.equal(true);
    });

    it("always lets default and the creator read", () => {
      const m = meta({ state: [], stream: [], volatile: [] });
      for (const part of ["state", "stream", "volatile"] as const) {
        expect(ReadLock.allowed(m, part, "default")).to.equal(true);
        expect(ReadLock.allowed(m, part, "owner")).to.equal(true);
        expect(ReadLock.allowed(m, part, "other")).to.equal(false);
      }
    });

    it("honours a list and a wildcard per part", () => {
      const m = meta({ state: ["a"], stream: "*", volatile: ["b"] });
      expect(ReadLock.allowed(m, "state", "a")).to.equal(true);
      expect(ReadLock.allowed(m, "state", "b")).to.equal(false);
      expect(ReadLock.allowed(m, "stream", "zzz")).to.equal(true);
      expect(ReadLock.allowed(m, "volatile", "b")).to.equal(true);
      expect(ReadLock.allowed(m, "volatile", "a")).to.equal(false);
    });

    it("refuses an unknown namespace on a restricted part", () => {
      expect(ReadLock.allowed(meta({ state: ["a"] }), "state", undefined)).to.equal(false);
    });
  });

  describe("read", () => {
    const docs: any = {
      "s:stream": { _id: "s:stream", ns: "owner", readLock: {} },
      "s:volatile": { _id: "s:volatile", secret: 1 },
      s: { _id: "s", balance: 1 },
    };
    const make = (withAllDocs: boolean) => {
      const calls: string[] = [];
      const db: any = {
        get: async (id: string) => {
          calls.push(`get ${id}`);
          if (!docs[id]) throw new Error("missing");
          return docs[id];
        },
      };
      if (withAllDocs) {
        db.allDocs = async (o: any) => {
          calls.push(`allDocs ${o.keys.join(",")}`);
          return { rows: o.keys.map((k: string) => ({ doc: docs[k] })).reverse() };
        };
      }
      return { db, calls };
    };

    it("does nothing below the build level", async () => {
      await withBuild(ReadLock.BUILD - 1, async () => {
        const { db, calls } = make(true);
        expect(await ReadLock.read(db, "s:volatile", "other")).to.equal(docs["s:volatile"]);
        expect(calls).to.deep.equal(["get s:volatile"]);
      });
    });

    it("reads the document and its meta in one call", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db, calls } = make(true);
        expect(await ReadLock.read(db, "s", "other")).to.equal(docs.s);
        expect(await ReadLock.read(db, "s:volatile", "owner")).to.equal(docs["s:volatile"]);
        expect(calls).to.deep.equal(["allDocs s,s:stream", "allDocs s:volatile,s:stream"]);
      });
    });

    it("refuses a volatile read by another namespace", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db } = make(true);
        let error: any;
        await ReadLock.read(db, "s:volatile", "other").catch((e) => (error = e));
        expect(error?.message).to.equal("Stream read locked");
      });
    });

    it("uses the meta of a stream the transaction already loaded", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db, calls } = make(true);
        const known = () => ({ ns: "owner", readLock: {} }) as any;
        expect(await ReadLock.read(db, "s:volatile", "owner", known)).to.equal(docs["s:volatile"]);
        expect(calls).to.deep.equal(["get s:volatile"]);
      });
    });

    it("reads the meta once when the meta is what is asked for", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db, calls } = make(true);
        expect(await ReadLock.read(db, "s:stream", "other")).to.equal(docs["s:stream"]);
        expect(calls).to.deep.equal(["get s:stream"]);
      });
    });

    it("reads separately from a store with no multi-read", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db, calls } = make(false);
        expect(await ReadLock.read(db, "s", "other")).to.equal(docs.s);
        expect(calls).to.deep.equal(["get s:stream", "get s"]);
      });
    });

    it("never refuses the default namespace and reads only the document", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db, calls } = make(true);
        await ReadLock.read(db, "s:volatile", "default");
        expect(calls).to.deep.equal(["get s:volatile"]);
      });
    });

    it("reports a missing document as the read itself would", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const { db } = make(true);
        let error: any;
        await ReadLock.read(db, "gone", "other").catch((e) => (error = e));
        expect(error?.message).to.equal("missing");
      });
    });

    it("answers from a private copy of the $i / $o locks", () => {
      const meta: any = { ns: "x", readLock: { volatile: ["a"] }, other: 1 };
      const streams: any = [{ state: { _id: "a" }, meta }];
      const lookup = ReadLock.snapshot(streams, undefined);
      // The contract is handed the same object; changing it changes nothing
      meta.readLock = {};
      meta.readLock.volatile = "*";
      const copy: any = lookup("a");
      expect(copy.ns).to.equal("x");
      expect(copy.readLock).to.deep.equal({ volatile: ["a"] });
      expect(copy.other).to.equal(undefined);
      expect(lookup("b")).to.equal(undefined);
    });

    it("refuses a read once the contract has edited the stream it was handed", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        const meta: any = { ns: "owner", readLock: {} };
        const lookup = ReadLock.snapshot([{ state: { _id: "s" }, meta }] as any);
        meta.readLock.volatile = "*";
        const db: any = { get: async () => ({}) };
        let error: any;
        await ReadLock.read(db, "s:volatile", "other", lookup).catch((e) => (error = e));
        expect(error?.message).to.equal("Stream read locked");
      });
    });
  });

  describe("the VM read handlers", () => {
    const docs: any = {
      "s:stream": { ns: "owner", readLock: {} },
      "s:volatile": { secret: 1 },
      s: { balance: 1 },
    };
    const fakeDb: any = {
      get: async (id: string) => {
        if (!docs[id]) throw new Error("missing");
        return docs[id];
      },
    };

    const ask = (event: string, answer: string, namespace: string, id: string) =>
      new Promise<{ err: any; data: any }>((resolve) => {
        const vm: any = new VirtualMachine("host", fakeDb, fakeDb);
        vm.contractReferences = { u: { tx: { $namespace: namespace } } };
        vm.emitter.once(`${answer}-u${id}`, (err: any, data: any) =>
          resolve({ err, data })
        );
        vm.emitter.emit(event, "u", id);
      });
    const volatile = (ns: string) => ask("getVolatile", "volatileFetched", ns, "s");
    const stream = (ns: string, id = "s") =>
      ask("getStreamData", "getStreamDataFetched", ns, id);

    it("refuses getVolatile to another namespace, allows the creator", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        expect((await volatile("other")).err.message).to.equal("Stream read locked");
        expect((await volatile("owner")).data).to.deep.equal({ secret: 1 });
      });
    });

    it("refuses getAnyStreamReadOnly of the volatile, allows the state", async () => {
      await withBuild(ReadLock.BUILD, async () => {
        expect((await stream("other", "s:volatile")).err.message).to.equal("Stream read locked");
        expect((await stream("other")).data).to.deep.equal({ balance: 1 });
      });
    });

    it("reads as it always did below the build level", async () => {
      await withBuild(ReadLock.BUILD - 1, async () => {
        expect((await volatile("other")).data).to.deep.equal({ secret: 1 });
      });
    });
  });

  describe("Activity.setReadLock", () => {
    const make = (name: string | null = "n", namespace: string = "owner") =>
      new Activity(
        "umid", name, false, new EventEmitter(), undefined, undefined,
        undefined, false, namespace
      );

    it("records the policy and the creating namespace", () => {
      const a: any = make();
      expect(a.setReadLock({ state: "*", volatile: ["x"] })).to.equal(true);
      expect(a.meta.ns).to.equal("owner");
      expect(a.meta.readLock).to.deep.equal({ state: "*", volatile: ["x"] });
    });

    it("cannot lock an existing stream", () => {
      expect(make(null).setReadLock({})).to.equal(false);
    });

    it("refuses a policy it cannot read", () => {
      const a: any = make();
      expect(() => a.setReadLock({ nope: "*" })).to.throw("no part named nope");
      expect(() => a.setReadLock({ state: "all" })).to.throw("must be");
      expect(() => a.setReadLock({ state: [1] })).to.throw("must be");
      expect(() => a.setReadLock([])).to.throw("object");
    });

    it("needs the namespace of the creating contract", () => {
      expect(() => make("n", "").setReadLock({})).to.throw("namespace");
    });
  });
});
