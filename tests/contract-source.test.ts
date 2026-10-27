import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ContractFiles,
  ContractSource,
  ContractSourceError,
} from "../packages/contracts/src/source";

const SOURCE = "export default class A { x: number = 1; }\n";
const b64 = Buffer.from(SOURCE).toString("base64");

const umidDoc = (umid: string, identity: string, contract: string) => ({
  _id: `${umid}:umid`,
  umid: { $umid: umid, $tx: { $i: { [identity]: { contract } } } },
});

describe("ContractSource", () => {
  it("hashes the decoded bytes, not the base64 envelope", () => {
    const padded = Buffer.from(SOURCE).toString("base64") + "\n";
    expect(ContractSource.hash(padded)).to.equal(ContractSource.hash(b64));
  });

  it("transpiles to the pinned edition", () => {
    const es2017 = ContractSource.transpile(b64);
    expect(es2017).to.contain("class A");
    expect(ContractSource.transpile(b64, "es2017")).to.equal(es2017);
    expect(ContractSource.transpile(b64, "es2025")).to.not.equal(es2017);
  });

  describe("resolve", () => {
    const never = async () => {
      throw new Error("must not fetch");
    };

    it("returns a legacy inline entry without fetching", async () => {
      const r = await ContractSource.resolve({ contract: { "1": b64 } }, "1", never);
      expect(r).to.deep.equal({ base64: b64, hash: ContractSource.hash(b64), target: "es2017" });
    });

    it("recovers a referenced source from its umid doc and checks the hash", async () => {
      const state = {
        identity: "idn",
        contract: { "2": { umid: "u1", hash: ContractSource.hash(b64), target: "es2025" as const } },
      };
      const r = await ContractSource.resolve(state, "2", async (u) => umidDoc(u, "idn", b64));
      expect(r.base64).to.equal(b64);
      expect(r.target).to.equal("es2025");
    });

    const refState = (hash: string, extra: any = {}) => ({
      identity: "idn",
      contract: { "2": { umid: "u1", hash, ...extra } },
    });

    it("rejects a source that does not match the recorded hash", async () => {
      const other = Buffer.from("other").toString("base64");
      let err: any;
      try {
        await ContractSource.resolve(refState(ContractSource.hash(b64)), "2", async (u) => umidDoc(u, "idn", other));
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ContractSourceError);
      expect(err.message).to.contain("does not match");
    });

    it("fails clearly for a hash-only entry, a missing umid doc, a missing version or no identity", async () => {
      const cases: [any, string, RegExp][] = [
        [{ identity: "idn", contract: { "2": { hash: "h" } } }, "2", /no umid/],
        [refState("h"), "2", /not held/],
        [refState("h"), "9", /No version 9/],
        [{ contract: { "2": { umid: "u1", hash: "h" } } }, "2", /no identity/],
        [{ identity: "idn", contract: { "2": { umid: 5 } } }, "2", /Malformed/],
      ];
      for (const [state, version, message] of cases) {
        let err: any;
        try {
          await ContractSource.resolve(state, version, async () => undefined);
        } catch (e) {
          err = e;
        }
        expect(err, message.source).to.be.instanceOf(ContractSourceError);
        expect(err.message).to.match(message);
      }
    });
  });
});

describe("ContractFiles", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));

  it("writes latest and the version, creating directories", () => {
    const root = dir();
    const files = new ContractFiles(path.join(root, "contracts"));
    files.write("ns", "name", "1.0", "code");
    expect(fs.readFileSync(path.join(root, "contracts/ns/name.js"), "utf8")).to.equal("code");
    expect(fs.readFileSync(path.join(root, "contracts/ns/name@1.0.js"), "utf8")).to.equal("code");
    expect(files.exists("ns", "name")).to.equal(true);
    expect(files.exists("ns", "missing")).to.equal(false);
  });

  it("locks and unlocks a contract or one version", () => {
    const root = dir();
    const files = new ContractFiles(root);
    files.write("ns", "name", "1", "c");
    expect(files.isLocked("ns", "name")).to.equal(false);
    files.lock("ns", "name");
    files.lock("ns", "name", "@1");
    expect(files.isLocked("ns", "name")).to.equal(true);
    expect(files.isLocked("ns", "name", "@1")).to.equal(true);
    expect(fs.existsSync(path.join(root, "ns/_LOCK.name@1"))).to.equal(true);
    files.unlock("ns", "name", "@1");
    expect(files.isLocked("ns", "name", "@1")).to.equal(false);
    expect(files.isLocked("ns", "name")).to.equal(true);
  });

  it("refuses names that would leave the root", () => {
    const files = new ContractFiles(dir());
    for (const bad of ["..", "../x", "a/b", "a\\b", ".hidden", "", "a..b", "/abs", "a\0b"]) {
      expect(() => files.write(bad, "name", "1", "c"), `ns ${bad}`).to.throw(/Unsafe/);
      expect(() => files.write("ns", bad, "1", "c"), `name ${bad}`).to.throw(/Unsafe/);
      expect(() => files.write("ns", "name", bad, "c"), `version ${bad}`).to.throw(/Unsafe/);
    }
    expect(() => files.lock("..", "c")).to.throw(/Unsafe/);
    expect(() => files.isLocked("ns", "c/../x")).to.throw(/Unsafe/);
  });

  it("accepts the labels real contracts use", () => {
    const files = new ContractFiles(dir());
    files.write("my-ns", "contract.my-ns.name@1.2.3", "1.2.3", "c");
    expect(files.exists("my-ns", "contract.my-ns.name@1.2.3")).to.equal(true);
  });
});
