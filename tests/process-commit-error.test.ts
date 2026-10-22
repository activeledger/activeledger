import { IActiveDSConnect } from "../packages/definitions/lib/definitions";
import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveLogger } from "@activeledger/activelogger";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";

// A throw in a contract's commit() reaches the caller only as the generic
// "Failed Commit Transaction" outside debug mode, so the node log has to carry
// the reason or it is lost.
describe("Process.commit - logging a contract commit failure (Activeprotocol)", () => {
  const vmscriptPath = "./packages/protocol/src/protocol/vmscript.js";

  const build = (): { process: Process; raised: any[] } => {
    const entry: any = {
      $umid: "umid-under-test",
      $origin: "origin-node",
      $nodes: { self: {} },
      $tx: { $namespace: "default", $contract: "onboard", $i: {}, $o: {} },
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

      const raised: any[] = [];
      (process as any).shared = {
        raiseLedgerError: (code: number, error: Error) => {
          raised.push({ code, message: error.message });
          return Promise.resolve();
        },
      };
      (process as any).contractId = "default.onboard";
      (process as any).nodeResponse = { vote: true, leader: true };

      return { process, raised };
    } finally {
      if (fs.existsSync(vmscriptPath)) {
        fs.unlinkSync(vmscriptPath);
      }
    }
  };

  let logged: string[];
  let original: typeof ActiveLogger.error;

  beforeEach(() => {
    logged = [];
    original = ActiveLogger.error;
    (ActiveLogger as any).error = (message: any) => logged.push(String(message));
  });

  afterEach(() => {
    (ActiveLogger as any).error = original;
  });

  it("logs the thrown text with the umid and contract", async () => {
    const { process } = build();
    const vm: any = {
      commit: () => Promise.reject(new Error("cDate.getTime is not a function")),
    };

    await (process as any).commit(vm);

    expect(logged).to.have.length(1);
    expect(logged[0]).to.contain("umid-under-test");
    expect(logged[0]).to.contain("default.onboard");
    expect(logged[0]).to.contain("cDate.getTime is not a function");
  });

  it("logs a thrown value that is not an Error", async () => {
    const { process } = build();
    const vm: any = { commit: () => Promise.reject("plain string reason") };

    await (process as any).commit(vm);

    expect(logged[0]).to.contain("plain string reason");
  });

  it("still gives the caller the generic message outside debug mode", async () => {
    const { process, raised } = build();
    const vm: any = {
      commit: () => Promise.reject(new Error("internal detail")),
    };

    await (process as any).commit(vm);

    expect(raised).to.deep.equal([
      { code: 1301, message: "Failed Commit Transaction" },
    ]);
  });
});
