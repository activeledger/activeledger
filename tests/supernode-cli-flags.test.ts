import { expect } from "chai";
import "mocha";
import { parseCli } from "../packages/options/src/cli";
import { supernodeProgram } from "../packages/activeledger/src/cli/program";

describe("Supernode CLI flags", () => {
  // Read from the command line by ActiveOptions.get when config.json lacks
  // the key, so a strict parser must not turn them away
  for (const key of ["gzip", "max_memory", "nanoGateway", "p2pStream", "p2pStreamServer", "queue_retry"]) {
    it(`accepts --${key}`, () => {
      const p = parseCli(supernodeProgram("5.1.0"), ["start", `--${key}`, "1"]);
      expect(p.errors).to.deep.equal([]);
    });
  }
});
