import { expect } from "chai";
import "mocha";
import { spawnSync } from "child_process";
import * as path from "path";
import { Maintain } from "../packages/network/src/network/maintain";

/**
 * What Maintain starts from, and what starting it does. The start-up values
 * are checked in a fresh process because the other tests in this one set
 * them. A node that began with a check or a rebase already "running" would
 * never do either.
 */
describe("Maintain start-up (Activenetwork)", () => {
  it("starts with no check, no rebase and no timer running", function () {
    // A fresh process loading TypeScript: slow on a busy machine
    this.timeout(60000);
    const script = `
      const { Maintain } = require("./packages/network/src/network/maintain");
      const M = Maintain;
      console.log(JSON.stringify({ checking: M.checking, rebasing: M.rebasing, timerActive: M.timerActive }));
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    const line = r.stdout.trim().split("\n").pop() as string;
    expect(JSON.parse(line)).to.deep.equal({ checking: false, rebasing: false, timerActive: false });
  });

  it("init orders the neighbours and starts the discovery timer", () => {
    const M = Maintain as any;
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = () => 0 as any;
    try {
      const n = { reference: "a", isHome: false, graceStop: false };
      M.timerActive = false;
      M.neighbourOrder = undefined;
      Maintain.init({ neighbourhood: { get: () => ({ a: n }), keys: () => ["a"] } } as any);
      expect(M.neighbourOrder).to.deep.equal([n]);
      expect(M.timerActive).to.equal(true);
    } finally {
      (global as any).setTimeout = realSetTimeout;
      M.timerActive = false;
    }
  });
});
