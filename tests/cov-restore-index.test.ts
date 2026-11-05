import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Helper } from "../packages/restore/src/modules/helper/helper";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { expect } from "chai";
import "mocha";

/**
 * The entry point wires Provider to either the interagent or a quick restore.
 */
describe("Restore entry point (cov)", () => {
  const realSetTimeout = global.setTimeout;
  const realExit = process.exit;
  const keep: any = {};
  let timers: { fn: Function; ms: number }[];
  let logs: string[];
  let exits: any[];
  let opts: Record<string, any>;

  beforeEach(() => {
    timers = [];
    logs = [];
    exits = [];
    opts = {};
    keep.initialise = (Provider as any).initialise;
    keep.get = (ActiveOptions as any).get;
    keep.info = (ActiveLogger as any).info;
    keep.error = (ActiveLogger as any).error;
    keep.quick = Provider.isQuickFullRestore;
    keep.verbose = Helper.verbose;
    (ActiveOptions as any).get = (k: string, d: any) => (k in opts ? opts[k] : d);
    (ActiveLogger as any).info = (...a: any[]) => logs.push(String(a[a.length - 1]));
    (ActiveLogger as any).error = (...a: any[]) => logs.push(String(a[a.length - 1]));
    (process as any).exit = (c: any) => exits.push(c);
    (global as any).setTimeout = (fn: Function, ms: number) => {
      timers.push({ fn, ms });
      return 0 as any;
    };
  });
  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    (process as any).exit = realExit;
    (Provider as any).initialise = keep.initialise;
    (ActiveOptions as any).get = keep.get;
    (ActiveLogger as any).info = keep.info;
    (ActiveLogger as any).error = keep.error;
    Provider.isQuickFullRestore = keep.quick;
    Helper.verbose = keep.verbose;
  });

  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("starts the interagent after initialising, for a normal restore", async () => {
    let initialised = 0;
    (Provider as any).initialise = async () => {
      initialised++;
      Provider.isQuickFullRestore = false;
    };
    Helper.verbose = true;
    await import("../packages/restore/src/index.ts?normal");
    await tick();
    await tick();
    expect(initialised).to.equal(1);
    expect(Helper.verbose).to.equal(false);
    expect(logs).to.include("Interagent Started");
    expect(logs.some((l) => l.includes("--skip-history"))).to.equal(false);
  });

  it("runs a quick restore, which ends the process, for a full restore", async () => {
    // Contradictory options make the restore stop straight away
    opts["skip-history"] = true;
    opts["history-only"] = true;
    (Provider as any).initialise = async () => {
      Provider.isQuickFullRestore = true;
    };
    await import("../packages/restore/src/index.ts?quick");
    await tick();
    await tick();
    await tick();
    expect(logs).to.not.include("Interagent Started");
    expect(logs.some((l) => l.includes("--skip-history and --history-only"))).to.equal(true);
    const exit = timers.find((t) => t.ms === 200)!;
    expect(exit, "exit scheduled").to.not.equal(undefined);
    exit.fn();
    expect(exits).to.deep.equal([1]);
  });
});
