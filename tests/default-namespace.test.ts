import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Namespace from "../packages/activeledger/src/contracts/default/namespace";
import { ActiveOptions } from "@activeledger/activeoptions";

// The default "namespace" contract claims a namespace by creating its folder
// under the contracts root. The name comes straight from the transaction, so it
// must be a plain label before any directory is made or looked at.
describe("Default namespace contract (Activeledger)", () => {
  let tmpDir: string;
  let cwd: string;
  let originalSecurity: any;

  before(() => {
    originalSecurity = ActiveOptions.get("security", undefined);
  });
  after(() => {
    if (originalSecurity === undefined) delete (ActiveOptions as any).config.security;
    else ActiveOptions.set("security", originalSecurity);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-namespace-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    // contracts/ lives inside a sandbox dir so an escape stays inside tmpDir
    fs.mkdirSync("sandbox/contracts", { recursive: true });
    delete (ActiveOptions as any).config.security;
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const make = (namespace: any) => {
    const c: any = Object.create(Namespace.prototype);
    c.rootDir = "./sandbox/contracts/";
    c.transactions = { $i: { identityStream: { namespace } } };
    const state: any = {};
    c.identity = { getId: () => "identityId", setState: (s: any) => Object.assign(state, s) };
    c.getActivityStreams = () => c.identity;
    c.state = state;
    return c;
  };
  const vote = (c: any): Promise<any> => (Namespace.prototype as any).vote.call(c);
  const commit = (c: any): Promise<any> => (Namespace.prototype as any).commit.call(c);
  const refusal = async (p: Promise<any>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a refusal but it resolved");
  };
  const tree = () => (fs.readdirSync(".", { recursive: true }) as string[]).map(String).sort();

  const unsafe: [string, string][] = [
    ["a traversal", "../x"],
    ["a traversal out of the contracts root", "../../x"],
    ["a nested path", "a/b"],
    ["an absolute path", "/tmp/escaped"],
    ["an empty string", ""],
    ["a parent reference", ".."],
    ["a hidden name", ".hidden"],
    ["a NUL byte", "a\u0000b"],
    ["a backslash", "a\\b"],
  ];

  for (const [what, value] of unsafe) {
    it(`refuses ${what} in the vote and creates nothing`, async () => {
      const before = tree();
      expect(await refusal(vote(make(value)))).to.match(/^Unsafe namespace/);
      expect(tree()).to.deep.equal(before);
    });

    it(`never creates a directory from ${what} at commit`, async () => {
      const before = tree();
      const c = make(value);
      c.namespace = value.toLowerCase();
      expect(await refusal(commit(c))).to.match(/Unsafe namespace/);
      expect(tree()).to.deep.equal(before);
    });
  }

  it("accepts and claims an ordinary label", async () => {
    for (const name of ["acme", "my-co_2", "co.v2", "Mixed-Case"]) {
      const c = make(name);
      expect(await vote(c), name).to.equal(true);
      expect(await commit(c), name).to.equal(true);
      const dir = `sandbox/contracts/${name.toLowerCase()}`;
      expect(fs.readFileSync(`${dir}/.identity`, "utf8")).to.equal("identityId");
      expect(c.state.namespace).to.equal(name.toLowerCase());
    }
  });

  it("still refuses the reserved default namespace and one that exists", async () => {
    expect(await refusal(vote(make("default")))).to.equal("Namespace Reserved");
    fs.mkdirSync("sandbox/contracts/taken");
    expect(await refusal(vote(make("taken")))).to.equal("Namespace Reserved");
  });
});
