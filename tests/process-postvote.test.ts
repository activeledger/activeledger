import { IActiveDSConnect } from "../packages/definitions/lib/definitions";
import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";

// A node's own vote failure has to be recorded against its own entry in
// $nodes, because that is the only signal network/endpoints.ts's
// InternalInitalise() has to decide that THIS node is the one holding a
// stale stream and should pull the network's revision over its own.
//
// The assignment used to sit inside `if (this.entry.$broadcast)`, so a
// non-broadcast (territorial / round-robin) transaction never recorded it.
// A node that fell behind on one of those could never self-heal: it voted
// "Stream Position Incorrect" against every later transaction touching the
// stream and nothing anywhere recorded that it had.
describe("Process.postVote - recording this node's own error (Activeprotocol)", () => {
  const vmscriptPath = "./packages/protocol/src/protocol/vmscript.js";

  const build = (broadcast: boolean): { process: Process; entry: any } => {
    const entry: any = {
      $origin: "origin-node",
      $broadcast: broadcast,
      $nodes: { self: {} },
      $tx: {
        $namespace: "default",
        $contract: "onboard",
        $i: {},
        $o: {},
      },
      $sigs: {},
      $selfsign: true,
    };

    fs.writeFileSync(vmscriptPath, "{}");
    try {
      const process = new Process(
        entry,
        "localhost:5259",
        "self",
        {
          reference: "right",
          knock: (): Promise<any> => new Promise(() => {}),
        } as any,
        {} as any,
        {} as any,
        {} as any,
        new ActiveCrypto.Secured({} as IActiveDSConnect, [], {}) as any
      );

      // postVote runs the commit / knock-right phase after recording the
      // vote; neither is under test here and both need a live network
      (process as any).commit = () => {};
      (process as any).emit = () => true;
      (process as any).shared = {
        raiseLedgerError: () => Promise.resolve(),
      };

      return { process, entry };
    } finally {
      if (fs.existsSync(vmscriptPath)) {
        fs.unlinkSync(vmscriptPath);
      }
    }
  };

  const positionError = {
    code: 1200,
    reason:
      "Output Stream Position Incorrect (21-799d345c:39-246bc890 !== 20-d89395f3:38-c54a2e1c - Local)",
  };

  it("records the error on a non-broadcast transaction", () => {
    // Previously left undefined, which silently disabled SPI self-repair
    const { process, entry } = build(false);

    (process as any).postVote({} as any, positionError);

    expect(entry.$nodes.self.error).to.equal(positionError.reason);
  });

  it("still records the error on a broadcast transaction", () => {
    const { process, entry } = build(true);

    (process as any).postVote({} as any, positionError);

    expect(entry.$nodes.self.error).to.equal(positionError.reason);
  });

  it("records a plain error that carries no reason", () => {
    const { process, entry } = build(false);

    (process as any).postVote({} as any, "Stream(s) not found");

    expect(entry.$nodes.self.error).to.equal("Stream(s) not found");
  });

  it("records nothing when the node voted without error", () => {
    const { process, entry } = build(false);

    (process as any).postVote({} as any);

    expect(entry.$nodes.self.error).to.equal(undefined);
  });
});
