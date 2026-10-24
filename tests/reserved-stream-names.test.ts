import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// By package name: vm.ts reads build through the built lib's ActiveOptions
import { ActiveOptions } from "@activeledger/activeoptions";
import { Stream } from "../packages/contracts/src/stream";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { ActiveCrypto } from "../packages/crypto/src";

// Stream names under activeledger.default. belong to the default namespace.
// A stream id is sha256(seed + name), so a contract in another namespace
// could create the hybrid registry's stream for a key before the real
// register does and block it with a collision.
describe("Reserved activeledger.default.* stream names", () => {
  const umid = "a".repeat(64);
  const keyhash = "b".repeat(64);
  const name = `activeledger.default.hybrid.${keyhash}`;

  const stream = ($namespace: string) =>
    new Stream(
      new Date(),
      "127.0.0.1",
      umid,
      { $namespace, $contract: "c", $i: {}, $o: {} } as any,
      [],
      [],
      {},
      {} as any,
      {},
      0,
      new EventEmitter(),
      "127.0.0.1:5260"
    );

  const reserved = ($namespace: string) => {
    const s = stream($namespace);
    s.setReservedStreams(true);
    return s;
  };

  it("refuses a non-default contract naming activeledger.default.hybrid.x", () => {
    expect(() => reserved("squat").newActivityStream(name, keyhash)).to.throw(
      /reserved for the default namespace/
    );
    expect(() =>
      reserved("squat").newActivityStream("activeledger.default.hybrid.x")
    ).to.throw(/reserved for the default namespace/);
  });

  it("refuses the same id with the name's start moved onto the seed", () => {
    // sha256(seed + name) is the same id for any split of the input
    expect(() =>
      reserved("squat").newActivityStream(
        name.slice(5),
        keyhash + name.slice(0, 5)
      )
    ).to.throw(/reserved for the default namespace/);
  });

  it("allows the default namespace", () => {
    const activity = reserved("default").newActivityStream(name, keyhash);
    expect(activity.getId()).to.equal(
      ActiveCrypto.Hash.getHash(keyhash + name, "sha256")
    );
  });

  it("is unchanged when not reserved (below the build)", () => {
    const s = stream("squat");
    s.setReservedStreams(false);
    expect(s.newActivityStream(name, keyhash).getId()).to.equal(
      ActiveCrypto.Hash.getHash(keyhash + name, "sha256")
    );
  });

  it("leaves ordinary names alone", () => {
    const s = reserved("squat");
    expect(s.newActivityStream("activeledger.defaults").getId()).to.equal(
      ActiveCrypto.Hash.getHash(umid + "activeledger.defaults", "sha256")
    );
    expect(s.newActivityStream("my.stream", "seed").getId()).to.equal(
      ActiveCrypto.Hash.getHash("seed" + "my.stream", "sha256")
    );
  });

  it("checks streams created before it was turned on, and cannot be turned off", () => {
    const s = stream("squat");
    s.newActivityStream(name, keyhash);
    expect(() => s.setReservedStreams(true)).to.throw(
      /reserved for the default namespace/
    );
    s.setReservedStreams(false);
    expect(() => s.newActivityStream("activeledger.default.x")).to.throw(
      /reserved for the default namespace/
    );
  });

  describe("through the VM", () => {
    let dir: string;
    let contractLocation: string;
    let originalBuild: any;

    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reserved-"));
      contractLocation = path.join(dir, "squat.js");
      // Creates the stream in its constructor, before any phase runs
      fs.writeFileSync(
        contractLocation,
        `const { Standard } = require(${JSON.stringify(
          require.resolve("@activeledger/activecontracts")
        )});
class Squat extends Standard {
  constructor(...args) {
    super(...args);
    this.newActivityStream(${JSON.stringify(name)}, ${JSON.stringify(keyhash)});
  }
  verify() { return Promise.resolve(true); }
  vote() { return Promise.resolve(true); }
  commit() { return Promise.resolve(); }
}
exports.default = Squat;
`
      );
      originalBuild = ActiveOptions.get("build", 0);
    });

    after(() => {
      ActiveOptions.set("build", originalBuild);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const initialise = (build: number, $namespace = "squat") => {
      ActiveOptions.set("build", build);
      const vm = new VirtualMachine(
        "localhost:5259",
        {} as any,
        {} as any,
        {} as any
      );
      const txUmid = `reserved-${build}-${$namespace}`;
      return vm.initialise(
        {
          contractLocation,
          umid: txUmid,
          date: new Date(),
          remoteAddress: "localhost",
          transaction: { $namespace, $contract: "squat", $i: {}, $o: {} },
          signatures: {},
          inputs: [],
          outputs: [],
          readonly: {},
          key: 1,
        } as any,
        "squat"
      );
    };

    it("rejects the contract from build 40300", async () => {
      let error: any;
      await initialise(40300).catch((e) => (error = e));
      expect(JSON.stringify(error)).to.match(
        /reserved for the default namespace/
      );
    });

    it("runs it below build 40300", async () => {
      await initialise(40200);
    });

    it("runs it in the default namespace", async () => {
      await initialise(40300, "default");
    });
  });
});
