import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildProcess, ProcessFixture, voteNodes } from "./helpers/process-fixture";

const nodeFsPromises: any = require("fs").promises;

describe("Process.start - contract location failures (cov)", () => {
  let dir: string;
  let cwd: string;
  let fixture: ProcessFixture;
  const restores: (() => void)[] = [];

  beforeEach(() => {
    cwd = globalThis.process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-process-start-"));
    fs.mkdirSync(`${dir}/contracts/ns`, { recursive: true });
    fs.mkdirSync(`${dir}/default_contracts`);
  });
  afterEach(() => {
    while (restores.length) restores.pop()!();
    globalThis.process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    Process.clearContractPathCache();
  });

  const run = async (contract = "abc") => {
    fixture = buildProcess({
      entry: { $tx: { $namespace: "ns", $contract: contract, $i: {}, $o: {} } },
    });
    fixture.proc.process = () => undefined;
    fixture.proc.postVote = () => undefined;
    fixture.proc.permissionChecker = {
      prefetch: () => Promise.resolve(),
      process: (ids: string[]) => Promise.resolve(ids.map((id) => ({ _id: id }))),
    };
    globalThis.process.chdir(dir);
    await fixture.proc.start();
    return fixture.entry.$nodes.self.error;
  };

  const patch = (key: string, fn: Function) => {
    const orig = nodeFsPromises[key];
    nodeFsPromises[key] = fn;
    restores.push(() => (nodeFsPromises[key] = orig));
  };

  it("names the errno code when the namespace cannot be resolved", async () => {
    patch("realpath", async () => {
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    });
    expect(await run()).to.equal("Init Contract Error - Namespace not found - EMFILE");
  });

  it("falls back to the error message when there is no errno code", async () => {
    patch("realpath", async () => {
      throw new Error("storage went away");
    });
    expect(await run()).to.equal("Init Contract Error - Namespace not found - storage went away");
  });

  it("falls back to the thrown value itself when it is neither", async () => {
    patch("realpath", async () => {
      throw "plain failure";
    });
    expect(await run()).to.equal("Init Contract Error - Namespace not found - plain failure");
  });

  it("reports the contract as not found when the namespace folder cannot be listed", async () => {
    fs.writeFileSync(`${dir}/contracts/ns/abc@1.0.0.js`, "");
    patch("readdir", async () => {
      throw new Error("EACCES");
    });
    expect(await run()).to.equal("Init Contract Error - Contract not found");
  });
});

describe("Process vote outcomes (cov)", () => {
  let savedLength: number;
  let savedConsensus: unknown;
  let savedDebug: unknown;
  let fixture: ProcessFixture;

  beforeEach(() => {
    savedLength = (Process as any).networkNodeLength;
    savedConsensus = ActiveOptions.get("consensus", null);
    savedDebug = ActiveOptions.get("debug", null);
    ActiveOptions.set("consensus", { reached: 66 });
  });
  afterEach(() => {
    if (fixture) {
      clearTimeout(fixture.proc.broadcastTimeout);
      clearTimeout(fixture.proc.willEmit);
    }
    (Process as any).networkNodeLength = savedLength;
    ActiveOptions.set("consensus", savedConsensus ?? undefined);
    ActiveOptions.set("debug", savedDebug ?? undefined);
  });

  const make = (spec: string, response: any, entry: any = {}, total = spec.length) => {
    fixture = buildProcess({ entry: { $nodes: voteNodes(spec), ...entry } });
    fixture.proc.reference = "n0";
    Object.assign(fixture.entry.$nodes.n0, response);
    fixture.proc.nodeResponse = fixture.entry.$nodes.n0;
    (Process as any).networkNodeLength = total;
    return fixture;
  };
  const vm: any = {
    commit: () => Promise.resolve(),
    getInternodeCommsFromVM: () => null,
    getReturnContractData: () => null,
    getActivityStreamsFromVM: () => [],
    reconcile: () => Promise.resolve(false),
  };

  describe("postVote on a broadcast transaction", () => {
    const vote = (error: any) => {
      const f = make("y", { vote: true }, { $broadcast: true });
      f.proc.commit = () => undefined;
      f.proc.postVote(vm, error);
      return f;
    };

    it("stores a missing stream error (950) as a failure of the transaction", () => {
      const f = vote({ code: 950, reason: "Stream(s) not found" });
      expect(f.raised).to.deep.equal([
        { code: 950, message: "Stream(s) not found", stop: undefined, priority: undefined },
      ]);
      expect(f.entry.$nodes.n0.error).to.equal("Stream(s) not found");
    });

    it("only stores a position error (1200), without failing the transaction twice", () => {
      const f = vote({ code: 1200, reason: "position" });
      expect(f.raised).to.deep.equal([
        { code: 1200, message: "position", stop: true, priority: undefined },
      ]);
    });

    it("raises nothing for any other vote error", () => {
      const f = vote({ code: 1220, reason: "sig" });
      expect(f.raised).to.deep.equal([]);
      expect(f.entry.$nodes.n0.error).to.equal("sig");
    });
  });

  describe("commit when the network cannot reach consensus", () => {
    it("tells a yes voter it failed for lack of quorum once enough nodes said no", async () => {
      // 1 yes, 3 no, 1 yet to answer: even a late yes (2/5) is short of 66%
      const f = make("ynnn", { vote: true }, { $broadcast: true }, 5);
      await f.proc.commit(vm);
      expect(f.raised).to.deep.equal([
        {
          code: 1510,
          message: "Failed Network Voting Round - No Quorum",
          stop: undefined,
          priority: undefined,
        },
      ]);
    });

    it("tells a yes voter there are no more voters when every node has answered", async () => {
      const f = make("ynnn", { vote: true }, { $broadcast: true }, 4);
      await f.proc.commit(vm);
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1510, "Failed Network Voting Round - No More Voters"],
      ]);
    });

    it("reports a no voter's own error once, even though more commit calls follow", async () => {
      const f = make("nyyn", { vote: false, error: "mine" }, { $broadcast: true }, 5);
      await f.proc.commit(vm);
      await f.proc.commit(vm);
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1505, "mine"]]);
    });
  });

  describe("commit after losing the vote but the network committed", () => {
    const lost = () =>
      make("nyyy", { vote: false, error: "contract said no" }, { $broadcast: false });

    it("just finishes when the recorded error was not a plain 1505", async () => {
      const f = lost();
      f.proc.shared.errorOut = { code: 1300, reason: "other", priority: 1 };
      let stored = 0;
      f.proc.shared.storeError = () => (stored++, Promise.resolve({}));
      await f.proc.commit(vm);
      expect(stored).to.equal(0);
      expect(f.events.map((e) => e.event)).to.deep.equal(["commited"]);
    });

    it("upgrades a 1505 to restorable 1001 at priority 11 and then finishes", async () => {
      const f = lost();
      f.proc.shared.errorOut = { code: 1505, reason: "contract said no", priority: 0 };
      const stored: any[] = [];
      f.proc.shared.storeError = (code: number, err: Error, prio: number) => {
        stored.push([code, err.message, prio]);
        return Promise.resolve({});
      };
      await f.proc.commit(vm);
      await new Promise((r) => setImmediate(r));
      expect(stored).to.deep.equal([[1001, "contract said no", 11]]);
      expect(f.events.map((e) => e.event)).to.deep.equal(["commited"]);
    });

    it("still finishes when storing the restorable error fails", async () => {
      const f = lost();
      f.proc.shared.errorOut = { code: 1505, reason: "contract said no", priority: 0 };
      f.proc.shared.storeError = () => Promise.reject(new Error("db down"));
      await f.proc.commit(vm);
      await new Promise((r) => setImmediate(r));
      expect(f.events.map((e) => e.event)).to.deep.equal(["commited"]);
    });
  });
});
