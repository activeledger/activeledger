import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "@activeledger/activeoptions";

// The default "contract" contract deploys, updates, links and locks the
// contracts every node runs. It is driven through its public phases over a
// hand-built context, as the other default contract tests do: what matters is
// what each entry accepts, refuses and leaves on disk, not a full execution.
// Add/update/lock on a live network are covered by tests/network/
// contract-entries.ts; link, unlink, the deploy controls and the refusals are
// not, and are what is pinned here.
describe("Default contract entries (Activeledger)", () => {
  const proto = (Contract as any).prototype;
  const stream = "c".repeat(64);
  const base64 = (src: string) => Buffer.from(src).toString("base64");
  const clean = base64("export default class Example {}\n");

  let tmpDir: string;
  let cwd: string;
  let originalBuild: any;
  let originalSecurity: any;

  before(() => {
    originalBuild = ActiveOptions.get("build", 0);
    originalSecurity = ActiveOptions.get("security", undefined);
  });
  after(() => {
    ActiveOptions.set("build", originalBuild);
    if (originalSecurity === undefined) delete (ActiveOptions as any).config.security;
    else ActiveOptions.set("security", originalSecurity);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-entries-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts/testns", { recursive: true });
    fs.mkdirSync("contracts/other", { recursive: true });
    delete (ActiveOptions as any).config.security;
    ActiveOptions.set("build", 40300);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  type Streams = { [name: string]: { state?: any; authority?: string } };

  // A contract instance with the Standard parts replaced by plain objects
  const make = (entry: string | undefined, input: any, extra: any = {}) => {
    const c: any = Object.create(Contract.prototype);
    const streams: Streams = extra.streams || {};
    c.rootDir = "./contracts/";
    c.umid = "a".repeat(64);
    c.version = ""; // the class field, which Object.create does not run
    c.transactions = {
      $namespace: "default",
      $contract: "contract",
      $entry: entry,
      $i: { identityStream: input },
      $o: extra.$o || {},
    };
    c.identity = {
      getName: () => "identityStream",
      getId: () => extra.id || "identityId",
      getState: () => ({ namespace: "testns", ...(extra.identityState || {}) }),
    };
    c.getActivityStreams = (name: string) => {
      const s = streams[name] || (streams[name] = { state: {} });
      return {
        getName: () => name,
        getState: () => s.state,
        setState: (n: any) => Object.assign(s.state, n),
        getAuthority: () => s.authority,
      };
    };
    return c;
  };

  const run = (method: string, ctx: any) =>
    new Promise<any>((resolve, reject) => proto[method].call(ctx, resolve, reject));
  const refusal = async (p: Promise<any>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a refusal but it resolved");
  };

  const setSecurity = (security: any) => ActiveOptions.set("security", security);
  const ref = (name: string) => `contracts/testns/${name}.js`;

  describe("verify", () => {
    it("refuses a signatureless transaction", async () => {
      const c = make("add", { version: "1.0.0" });
      expect(await refusal(proto.verify.call(c, true))).to.equal("Signatures Needed");
    });

    it("accepts a signed deploy that names a version", async () => {
      const c = make("add", { version: "1.0.0" });
      expect(await proto.verify.call(c, false)).to.equal(true);
    });

    it("refuses a signed deploy with no version, or one that is not a string", async () => {
      for (const version of [undefined, 1, { a: 1 }, ["1.0.0"]]) {
        const c = make("add", { version });
        expect(await refusal(proto.verify.call(c, false)), JSON.stringify(version)).to.equal("No Version Found");
      }
    });

    it("lets a link carry no version, since a link names a contract not a build", async () => {
      expect(await proto.verify.call(make("link", { link: "alias" }), false)).to.equal(true);
    });

    it("lets an unlink carry no version either", async () => {
      expect(await proto.verify.call(make("unlink", { link: "alias" }), false)).to.equal(true);
    });

    it("still needs a version on a lock, which is a plain entry", async () => {
      expect(await refusal(proto.verify.call(make("lock", {}), false))).to.equal("No Version Found");
    });
  });

  describe("vote and commit routing", () => {
    const route = async (phase: "vote" | "commit", prefix: "vote" | "commit") => {
      const names: { [entry: string]: string } = {
        update: "Update",
        link: "Link",
        unlink: "Unlink",
        lock: "Lock",
        unlock: "Unlock",
        add: "Add",
        undefined: "Add",
        "something-else": "Add",
      };
      for (const entry of Object.keys(names)) {
        const c = make(entry === "undefined" ? undefined : entry, {});
        const called: string[] = [];
        for (const n of new Set(Object.values(names))) {
          c[prefix + n] = (resolve: any) => {
            called.push(n);
            resolve(true);
          };
        }
        await proto[phase].call(c);
        expect(called, `${phase} ${entry}`).to.deep.equal([names[entry]]);
      }
    };

    it("sends each entry to its own vote handler, and anything unknown to add", () => route("vote", "vote"));
    it("sends each entry to its own commit handler, and anything unknown to add", () => route("commit", "commit"));

    it("rejects, rather than throws, a vote whose input is malformed", async () => {
      const c = make("link", { namespace: 7, contract: stream, link: "x" });
      const err = await refusal(proto.vote.call(c));
      expect(err).to.be.instanceOf(TypeError);
    });
  });

  describe("deploy allowlist", () => {
    // Every entry that puts or changes code on a node asks the same question
    const entries: [string, string, any][] = [
      ["voteAdd", "add", { namespace: "testns", name: "example", contract: clean, version: "1.0.0" }],
      ["voteUpdate", "update", { namespace: "testns", name: "example", contract: clean, version: "1.0.1" }],
      ["voteLink", "link", { namespace: "testns", contract: stream, link: "alias" }],
      ["voteUnlink", "unlink", { namespace: "testns", contract: stream, link: "alias" }],
      ["voteLock", "lock", { namespace: "testns", contract: stream }],
      ["voteUnlock", "unlock", { namespace: "testns", contract: stream }],
    ];

    it("refuses an identity that is not on a configured list, on every entry", async () => {
      setSecurity({ deploy: { allowlist: ["someone-else"] } });
      for (const [method, entry, input] of entries) {
        const err = await refusal(run(method, make(entry, input, { id: "mallory" })));
        expect(err, method).to.equal("Deployer not permitted");
      }
    });

    it("lets a listed identity through to the next check", async () => {
      setSecurity({ deploy: { allowlist: ["alice"] } });
      // Past the allowlist this link is refused for a different reason
      const err = await refusal(
        run("voteLink", make("link", { namespace: "other", contract: stream, link: "alias" }, { id: "alice" }))
      );
      expect(err).to.equal("Invalid Namespace");
    });

    it("is unrestricted when absent, empty or not a list", async () => {
      for (const deploy of [undefined, {}, { allowlist: [] }, { allowlist: "alice" }, { allowlist: null }]) {
        setSecurity({ deploy });
        const err = await refusal(
          run("voteLink", make("link", { namespace: "other", contract: stream, link: "alias" }, { id: "anyone" }))
        );
        expect(err, JSON.stringify(deploy)).to.equal("Invalid Namespace");
      }
      // And a security block that is not an object at all
      setSecurity(null);
      expect(
        await refusal(run("voteLink", make("link", { namespace: "other", contract: stream, link: "x" })))
      ).to.equal("Invalid Namespace");
    });
  });

  describe("namespace ownership", () => {
    it("refuses every entry on a namespace the signer does not own", async () => {
      const other = (o: any) => ({ namespace: "other", ...o });
      const cases: [string, string, any][] = [
        ["voteAdd", "add", other({ name: "example", contract: clean, version: "1.0.0" })],
        ["voteUpdate", "update", other({ name: "example", contract: clean, version: "1.0.0" })],
        ["voteLink", "link", other({ contract: stream, link: "alias" })],
        ["voteUnlink", "unlink", other({ contract: stream, link: "alias" })],
        ["voteLock", "lock", other({ contract: stream })],
        ["voteUnlock", "unlock", other({ contract: stream })],
      ];
      for (const [method, entry, input] of cases) {
        expect(await refusal(run(method, make(entry, input))), method).to.equal("Invalid Namespace");
      }
    });

    it("compares namespaces case-insensitively, as the request is lowercased", async () => {
      fs.writeFileSync(ref(stream), "");
      const c = make("link", { namespace: "TestNS", contract: stream.toUpperCase(), link: "Alias" });
      expect(await run("voteLink", c)).to.equal(true);
    });
  });

  describe("link and unlink", () => {
    it("refuses a link to a contract that is not in the namespace", async () => {
      const c = make("link", { namespace: "testns", contract: stream, link: "alias" });
      expect(await refusal(run("voteLink", c))).to.equal("Contract not found in namespace");
    });

    it("refuses a link whose name is taken", async () => {
      fs.writeFileSync(ref(stream), "");
      fs.writeFileSync(ref("alias"), "");
      const c = make("link", { namespace: "testns", contract: stream, link: "alias" });
      expect(await refusal(run("voteLink", c))).to.equal("Link already exists");
    });

    it("makes a link a symlink to the contract, and removing it leaves the contract", async () => {
      fs.writeFileSync(ref(stream), "class A {}");
      const c = make("link", { namespace: "testns", contract: stream, link: "alias" });
      expect(await run("voteLink", c)).to.equal(true);
      expect(await run("commitLink", c)).to.equal(true);
      expect(fs.lstatSync(ref("alias")).isSymbolicLink()).to.equal(true);
      expect(fs.readFileSync(ref("alias"), "utf8")).to.equal("class A {}");

      const u = make("unlink", { namespace: "testns", contract: stream, link: "alias" });
      expect(await run("voteUnlink", u)).to.equal(true);
      expect(await run("commitUnlink", u)).to.equal(true);
      expect(fs.existsSync(ref("alias"))).to.equal(false);
      expect(fs.readFileSync(ref(stream), "utf8")).to.equal("class A {}");
    });

    it("refuses to unlink a link that does not exist", async () => {
      const c = make("unlink", { namespace: "testns", contract: stream, link: "alias" });
      expect(await refusal(run("voteUnlink", c))).to.equal("Link doesn't exists");
    });

    // A link name becomes a path. A namespace's owner must not be able to name
    // a file in somebody else's namespace, and so unlink (delete) it, or plant
    // a link there.
    it("cannot unlink a file outside its own namespace", async () => {
      fs.writeFileSync("contracts/other/victim.js", "class Victim {}");
      const u = make("unlink", { namespace: "testns", contract: stream, link: "../other/victim" });
      const err = await run("voteUnlink", u).then(
        () => undefined,
        (e) => e
      );
      expect(err, "the vote must refuse it").to.be.a("string");
      expect(fs.existsSync("contracts/other/victim.js")).to.equal(true);
    });

    it("cannot link to a place outside its own namespace", async () => {
      fs.writeFileSync(ref(stream), "");
      const c = make("link", { namespace: "testns", contract: stream, link: "../other/planted" });
      const err = await run("voteLink", c).then(
        () => undefined,
        (e) => e
      );
      expect(err, "the vote must refuse it").to.be.a("string");
      expect(fs.existsSync("contracts/other/planted.js")).to.equal(false);
    });

    it("cannot lock or unlock a contract named by a path", async () => {
      fs.writeFileSync("contracts/other/victim.js", "");
      for (const method of ["voteLock", "voteUnlock"]) {
        const c = make(method === "voteLock" ? "lock" : "unlock", {
          namespace: "testns",
          contract: "../other/victim",
        });
        const err = await run(method, c).then(
          () => undefined,
          (e) => e
        );
        expect(err, method).to.be.a("string");
      }
    });
  });

  describe("lock", () => {
    it("refuses to lock a contract that is not in the namespace", async () => {
      const c = make("lock", { namespace: "testns", contract: stream });
      expect(await refusal(run("voteLock", c))).to.equal("Contract not found in namespace");
    });

    it("refuses a second lock, and an unlock when nothing is locked", async () => {
      fs.writeFileSync(ref(stream), "");
      const lock = make("lock", { namespace: "testns", contract: stream });
      expect(await run("voteLock", lock)).to.equal(true);
      await run("commitLock", lock);
      const again = make("lock", { namespace: "testns", contract: stream });
      expect(await refusal(run("voteLock", again))).to.equal("Lock already exists");
      const unlock = make("unlock", { namespace: "testns", contract: stream });
      expect(await run("voteUnlock", unlock)).to.equal(true);
      await run("commitUnlock", unlock);
      const gone = make("unlock", { namespace: "testns", contract: stream });
      expect(await refusal(run("voteUnlock", gone))).to.equal("Lock doesn't exists");
    });

    it("keeps a version's lock apart from the contract's own", async () => {
      fs.writeFileSync(ref(stream), "");
      const held = make("lock", { namespace: "testns", contract: stream, version: "1.0.0" });
      await run("voteLock", held);
      await run("commitLock", held);
      // 1.0.0 is held, the whole contract is not
      expect(await run("voteLock", make("lock", { namespace: "testns", contract: stream }))).to.equal(true);
      expect(
        await refusal(run("voteLock", make("lock", { namespace: "testns", contract: stream, version: "1.0.0" })))
      ).to.equal("Lock already exists");
    });
  });

  describe("add", () => {
    it("accepts a clean contract on a namespace the signer owns", async () => {
      const c = make("add", { namespace: "testns", name: "Example", contract: clean, version: "1.0.0" });
      expect(await run("voteAdd", c)).to.equal(true);
      expect(c.name).to.equal("example");
    });

    it("refuses a contract that fails the security scan, with the reason", async () => {
      const bad = base64("export default class A { run() { return process.env; } }");
      const c = make("add", { namespace: "testns", name: "example", contract: bad, version: "1.0.0" });
      expect(await refusal(run("voteAdd", c))).to.match(/^Security Violation \[1:\d+\]: .*process/);
    });

    it("skips the scan for the privileged default namespace", async () => {
      const bad = base64("process.exit(1);");
      const c = make("add", { namespace: "default", name: "example", contract: bad, version: "1.0.0" }, {
        identityState: { namespace: "default" },
      });
      expect(await run("voteAdd", c)).to.equal(true);
    });

    it("creates the namespace folder on commit when it is missing", async () => {
      fs.rmSync("contracts/testns", { recursive: true });
      const c = make("add", { namespace: "testns", name: "example", contract: clean, version: "1.0.0" });
      c.namespace = "testns";
      c.name = "example";
      c.newActivityStream = () => ({
        getName: () => stream,
        getState: () => ({}),
        setState: () => undefined,
        setAuthority: () => undefined,
      });
      await run("commitAdd", c);
      expect(fs.existsSync(ref(stream))).to.equal(true);
    });
  });

  describe("update", () => {
    const input = (more: any = {}) => ({
      namespace: "testns",
      name: "example",
      contract: clean,
      version: "1.1.0",
      ...more,
    });
    const withStream = (more: any = {}, extra: any = {}) =>
      make("update", input(more), {
        $o: { [stream]: {} },
        streams: { [stream]: { state: { contract: { "1.0.0": "x" } }, authority: "identityStream" } },
        ...extra,
      });

    it("accepts a clean update of the namespace's contract", async () => {
      expect(await run("voteUpdate", withStream())).to.equal(true);
    });

    it("refuses an update that fails the security scan", async () => {
      const bad = base64("export default class A { run() { eval('1'); } }");
      expect(await refusal(run("voteUpdate", withStream({ contract: bad })))).to.match(/Security Violation.*eval/);
    });

    it("refuses a lock request the build cannot honour, before anything is committed", async () => {
      ActiveOptions.set("build", 40200);
      expect(await refusal(run("voteUpdate", withStream({ lock: "all" })))).to.equal(
        "Locking versions on update needs build 40300"
      );
    });

    it("refuses a lock request naming an unknown version, the version being deployed, or junk", async () => {
      expect(await refusal(run("voteUpdate", withStream({ lock: ["9.9.9"] })))).to.equal(
        "Cannot lock unknown version 9.9.9"
      );
      expect(await refusal(run("voteUpdate", withStream({ lock: ["1.1.0"] })))).to.equal(
        "Cannot lock the version being deployed"
      );
      for (const lock of [7, "some", {}, [1], [null], new Array(1001).fill("1.0.0")]) {
        expect(await refusal(run("voteUpdate", withStream({ lock }))), JSON.stringify(lock).slice(0, 20)).to.equal(
          'lock must be "all" or an array of version names'
        );
      }
    });

    it("accepts an update with no output stream, as there is then nothing to lock", async () => {
      const c = make("update", input(), { $o: {} });
      expect(await run("voteUpdate", c)).to.equal(true);
    });

    describe("contract ownership", () => {
      it("is not enforced unless switched on", async () => {
        const c = withStream({}, { streams: { [stream]: { state: { contract: {} }, authority: "somebody-else" } } });
        expect(await run("voteUpdate", c)).to.equal(true);
      });

      it("refuses an update by anyone but the identity that deployed it", async () => {
        setSecurity({ deploy: { enforceContractOwnership: true } });
        const c = withStream({}, {
          id: "mallory",
          streams: { [stream]: { state: { contract: {} }, authority: "alice" } },
        });
        expect(await refusal(run("voteUpdate", c))).to.equal("Not contract owner");
      });

      it("refuses an update with no output to take the owner from, or an owner never recorded", async () => {
        setSecurity({ deploy: { enforceContractOwnership: true } });
        expect(await refusal(run("voteUpdate", make("update", input(), { id: "alice" })))).to.equal(
          "Not contract owner"
        );
        const noOwner = withStream({}, { id: "alice", streams: { [stream]: { state: { contract: {} } } } });
        expect(await refusal(run("voteUpdate", noOwner))).to.equal("Not contract owner");
      });

      it("lets the deploying identity update its own contract", async () => {
        setSecurity({ deploy: { enforceContractOwnership: true } });
        const c = withStream({}, {
          id: "alice",
          streams: { [stream]: { state: { contract: {} }, authority: "alice" } },
        });
        expect(await run("voteUpdate", c)).to.equal(true);
      });
    });
  });

  describe("recording locks in state", () => {
    it("merges and sorts versions, and never loses the global lock", () => {
      const st = Contract.recordLocks({ locks: { all: true, versions: ["2.0.0"] } }, ["1.0.0", "2.0.0", "1.0.0"]);
      expect(st.locks).to.deep.equal({ all: true, versions: ["1.0.0", "2.0.0"] });
    });

    it("tolerates a recorded lock with no versions list", () => {
      expect(Contract.recordLocks({ locks: {} }, ["1.0.0"]).locks).to.deep.equal({ versions: ["1.0.0"] });
    });

    it("forgetting a lock that was never recorded changes nothing", () => {
      const st: any = { name: "x" };
      expect(Contract.forgetLock(st, "1.0.0")).to.deep.equal({ name: "x" });
    });

    it("forgetting tolerates a record with no versions list, and keeps the record", () => {
      const st = Contract.forgetLock({ locks: { all: true } }, "");
      expect(st.locks).to.deep.equal({ versions: [] });
    });
  });
});
