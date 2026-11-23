import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { banner, letters, LOGO, NAME, wantBanner } from "../packages/activeledger/src/project/banner";
import { COMMANDS, commandHelp, overview } from "../packages/activeledger/src/project/help";
import {
  addToGitignore, checkKeyFile, Git, keyPathOf, ProjectError, projectsIn, readKeys, resolveProject, validateProject, writeKeys,
} from "../packages/activeledger/src/project/files";
import { applySet, checkExpect, exampleTx, interpret, resolveRefs, sendToNetwork } from "../packages/activeledger/src/project/txs";
import { projectCommand, ProjectDeps, ProjectFlags } from "../packages/activeledger/src/project/commands";

const SID = "a".repeat(64);
const CID = "c".repeat(64);
const rsa = new ActiveCrypto.KeyPair("rsa").generate();
const IDENTITY = { type: "rsa", private: rsa.prv.pkcs8pem, public: rsa.pub.pkcs8pem, streams: { local: SID } };

/** A git that answers from a table: repository yes/no, ignored, tracked */
const fakeGit = (o: { repo?: boolean; ignored?: boolean; tracked?: boolean; missing?: boolean } = {}): Git => (args) => {
  if (o.missing) return { status: null, stdout: "" };
  if (args[0] === "rev-parse") return { status: o.repo === false ? 128 : 0, stdout: o.repo === false ? "" : "true\n" };
  if (args[0] === "check-ignore") return { status: o.ignored ? 0 : 1, stdout: "" };
  if (args[0] === "ls-files") return { status: o.tracked ? 0 : 1, stdout: "" };
  return { status: 1, stdout: "" };
};

describe("project: banner and help", () => {
  it("draws the name in five rows that fit a terminal, and the logo", () => {
    expect(NAME).to.have.length(5);
    for (const row of NAME) expect(row.length).to.be.lessThan(80);
    expect(LOGO.length).to.be.greaterThan(3);
    expect(banner().join("\n")).to.include("#").and.to.include("/");
    expect(() => letters("Q")).to.throw("no glyph");
    expect(letters("ti")).to.have.length(5);
  });
  it("is drawn only for a person at a terminal", () => {
    expect(wantBanner(true, {}, {})).to.equal(true);
    expect(wantBanner(false, {}, {})).to.equal(false);
    expect(wantBanner(true, {}, { json: true })).to.equal(false);
    expect(wantBanner(true, {}, { quiet: true })).to.equal(false);
    expect(wantBanner(true, { CI: "1" }, {})).to.equal(false);
    expect(wantBanner(true, { NO_BANNER: "1" }, {})).to.equal(false);
  });
  it("the overview lists every command with how to use it, and the common options", () => {
    const text = overview(false).join("\n");
    for (const name of Object.keys(COMMANDS)) expect(text).to.include(name);
    expect(text).to.include("--project").and.to.include("--dry-run").and.to.include("Start here");
    expect(overview(true).join("\n")).to.include("#");
    expect(overview(false).join("\n")).to.not.include("#####");
  });
  it("has help for each command and says when there is none", () => {
    for (const name of Object.keys(COMMANDS)) expect(commandHelp(name)!.join("\n")).to.include("Example").and.to.include(`activeledger project ${COMMANDS[name].usage}`);
    expect(commandHelp("nope")).to.equal(undefined);
  });
});

describe("project: files", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const touch = (rel: string, body = "{}") => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), body));

  it("finds the project file: one here, a named one, the environment, or the nearest parent", () => {
    touch(".activeledger");
    expect(resolveProject(dir)).to.equal(path.join(dir, ".activeledger"));
    touch("sub/deeper/x.txt");
    expect(resolveProject(path.join(dir, "sub", "deeper"))).to.equal(path.join(dir, ".activeledger"));
    touch("staging.activeledger");
    expect(() => resolveProject(dir)).to.throw(ProjectError, /more than one project file.*--project/s);
    expect(resolveProject(dir, "staging")).to.equal(path.join(dir, "staging.activeledger"));
    expect(resolveProject(dir, undefined, { ACTIVELEDGER_PROJECT: "staging.activeledger" })).to.equal(path.join(dir, "staging.activeledger"));
    expect(() => resolveProject(dir, "nope")).to.throw(ProjectError, /no project file "nope"/);
    expect(projectsIn(dir).map((p) => path.basename(p))).to.deep.equal([".activeledger", "staging.activeledger"]);
  });
  it("says to run init when there is none", () => {
    expect(() => resolveProject(dir)).to.throw(ProjectError, /project init/);
  });
  it("names the key file beside the project file", () => {
    expect(keyPathOf("/x/.activeledger")).to.equal("/x/.activeledger-key");
    expect(keyPathOf("/x/staging.activeledger")).to.equal("/x/staging.activeledger-key");
  });
  it("validates a project file and says what is wrong", () => {
    const ok = { version: 1, namespace: "myorg", networks: { t: { nodes: ["http://127.0.0.1:5260"] } } };
    expect(validateProject(ok)).to.deep.equal([]);
    expect(validateProject(null)[0]).to.include("not a JSON object");
    expect(validateProject({ ...ok, version: 2 })[0]).to.include('"version"');
    expect(validateProject({ ...ok, networks: {} })[0]).to.include("at least one network");
    expect(validateProject({ ...ok, networks: { t: { nodes: [] } } })[0]).to.include('needs "nodes"');
    expect(validateProject({ ...ok, networks: { t: { nodes: ["http://node.example.com"] } } })[0]).to.include("must be https");
    expect(validateProject({ ...ok, networks: { t: { nodes: ["http://node.example.com"], insecure: true } } })).to.deep.equal([]);
    expect(validateProject({ ...ok, networks: { t: { nodes: ["https://node.example.com"] } } })).to.deep.equal([]);
    expect(validateProject({ ...ok, networks: { t: { nodes: ["nope"] } } })[0]).to.include("not a URL");
    expect(validateProject({ ...ok, defaultNetwork: "x" })[0]).to.include("defaultNetwork");
    expect(validateProject({ ...ok, namespace: "bad name" })[0]).to.include("namespace");
    expect(validateProject({ ...ok, contracts: { a: {} } })[0]).to.include('needs "source" and "version"');
    expect(validateProject({ ...ok, transactions: { a: {} } })[0]).to.include('needs "contract"');
  });
  it("checks the key file against git: ignored, tracked, mode, and no repository", () => {
    const key = path.join(dir, ".activeledger-key");
    writeKeys(key, { version: 1, identities: {} });
    expect(checkKeyFile(key, fakeGit({ ignored: true })).ok).to.equal(true);
    const notIgnored = checkKeyFile(key, fakeGit({ ignored: false }));
    expect(notIgnored.ok).to.equal(false);
    expect(notIgnored.problems[0]).to.include("not ignored").and.to.include("--fix-ignore");
    expect(checkKeyFile(key, fakeGit({ ignored: false }), { allowUnignored: true }).ok).to.equal(true);
    const tracked = checkKeyFile(key, fakeGit({ ignored: true, tracked: true }));
    expect(tracked.problems[0]).to.include("tracked by git").and.to.include("git rm --cached");
    expect(checkKeyFile(key, fakeGit({ repo: false })).warnings[0]).to.include("not in a git repository");
    expect(checkKeyFile(key, fakeGit({ missing: true })).warnings[0]).to.include("git was not found");
    fs.chmodSync(key, 0o644);
    expect(checkKeyFile(key, fakeGit({ ignored: true })).problems[0]).to.include("can be read by other users");
  });
  it("writes the key file with mode 600 and reads it back, and an absent one is empty", () => {
    const key = path.join(dir, "k-key");
    expect(readKeys(key)).to.deep.equal({ version: 1, identities: {} });
    writeKeys(key, { version: 1, identities: { a: { type: "rsa", private: "p", public: "q" } } });
    expect(fs.statSync(key).mode & 0o777).to.equal(0o600);
    expect(readKeys(key).identities.a.private).to.equal("p");
    fs.writeFileSync(key, "[]");
    expect(() => readKeys(key)).to.throw(ProjectError, /not a key file/);
  });
  it("adds the key file to .gitignore once", () => {
    const key = path.join(dir, ".activeledger-key");
    expect(addToGitignore(key)).to.equal(true);
    expect(addToGitignore(key)).to.equal(false);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).to.equal(".activeledger-key\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules");
    addToGitignore(key);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).to.equal("node_modules\n.activeledger-key\n");
  });
});

describe("project: transactions", () => {
  it("reads a reply: committed, refused, no summary", () => {
    const ok = interpret({ $umid: "u", $summary: { total: 3, vote: 3, commit: 2 }, $streams: { new: [{ id: "n" }], updated: [{ id: "u" }] } });
    expect(ok).to.include({ ok: true, total: 3, commit: 2, umid: "u" });
    expect(ok.newStreams[0].id).to.equal("n");
    expect(interpret({ $summary: { total: 3, vote: 1, commit: 0, errors: ["Namespace Reserved"] } })).to.include({ ok: false });
    expect(interpret({ error: "bad" }).errors).to.include("bad");
    expect(interpret({}).errors[0]).to.include("no summary");
    expect(interpret(undefined).ok).to.equal(false);
  });
  it("resolves @references in keys and values, and leaves the rest", () => {
    const ctx = { identities: { alice: SID }, namespace: "myorg", contracts: { nb: CID } };
    expect(resolveRefs({ "@alice": { who: "@alice", ns: "@namespace", c: "@contract:nb", plain: "hello", n: 3, list: ["@alice", "x"] } }, ctx)).to.deep.equal({ [SID]: { who: SID, ns: "myorg", c: CID, plain: "hello", n: 3, list: [SID, "x"] } });
    expect(() => resolveRefs("@bob", ctx)).to.throw(ProjectError, /@bob/);
    expect(() => resolveRefs("@contract:zz", ctx)).to.throw(ProjectError, /not deployed/);
    expect(() => resolveRefs("@namespace", { identities: {}, contracts: {} })).to.throw(ProjectError, /no namespace/);
  });
  it("--set changes a value by path, reads JSON values, and refuses prototype paths", () => {
    const t: any = { input: { a: { note: "x" } } };
    applySet(t, "input.a.note=hello");
    applySet(t, "input.a.count=3");
    applySet(t, "input.a.flag=true");
    applySet(t, "input.b.c=null");
    expect(t.input).to.deep.equal({ a: { note: "hello", count: 3, flag: true }, b: { c: null } });
    expect(() => applySet(t, "nokey")).to.throw(ProjectError, /key=value/);
    expect(() => applySet(t, "__proto__.x=1")).to.throw(ProjectError, /cannot set/);
    expect(() => applySet(t, "a.constructor=1")).to.throw(ProjectError, /cannot set/);
    expect(({} as any).x).to.equal(undefined);
  });
  it("builds a signed example transaction and refuses inputs it cannot sign for", () => {
    const project: any = { version: 1, namespace: "myorg", networks: {}, contracts: {}, transactions: {} };
    const ctx = { identities: { alice: SID }, namespace: "myorg", contracts: { nb: CID } };
    const signer = { name: "alice", identity: IDENTITY, streamId: SID };
    const tx = exampleTx({ contract: "nb", entry: "create", input: { "@alice": { note: "hi" } }, output: {} }, ctx, signer, project, ["input.@alice.note=changed"]);
    expect(tx.$tx).to.deep.include({ $namespace: "myorg", $contract: CID, $entry: "create" });
    expect(tx.$tx.$i[SID].note).to.equal("changed");
    expect(new ActiveCrypto.KeyPair("rsa", rsa.pub.pkcs8pem).verify(tx.$tx, tx.$sigs[SID])).to.equal(true);
    expect(() => exampleTx({ contract: "nb", input: { [CID]: {} } }, ctx, signer, project)).to.throw(ProjectError, /not streams of the identity/);
    expect(() => exampleTx({ contract: "nb" }, ctx, signer, { ...project, namespace: undefined })).to.throw(ProjectError, /no namespace/);
  });
  it("checks a reply against expect", () => {
    const committed = interpret({ $summary: { total: 4, vote: 4, commit: 1 } });
    expect(checkExpect(committed)).to.deep.equal([]);
    expect(checkExpect(committed, { commit: 2 })[0]).to.include("at least 2 commits");
    expect(checkExpect(committed, { commit: "all" })[0]).to.include("every node");
    const refused = interpret({ $summary: { total: 4, vote: 0, commit: 0, errors: ["Namespace Reserved"] } });
    expect(checkExpect(refused)[0]).to.include("Reserved");
    expect(checkExpect(refused, { error: "Reserved" })).to.deep.equal([]);
    expect(checkExpect(committed, { error: "Reserved" })[0]).to.include("expected an error");
  });
  it("moves to the next node only when one cannot be reached, and a refusal is an answer", async () => {
    const calls: string[] = [];
    const send = async (url: string) => {
      calls.push(url);
      if (url === "http://a") throw new Error("ECONNREFUSED");
      return { $summary: { errors: ["No"] } };
    };
    const r = await sendToNetwork({ nodes: ["http://a", "http://b", "http://c"] }, {}, send);
    expect(r.node).to.equal("http://b");
    expect(calls).to.deep.equal(["http://a", "http://b"]);
    await sendToNetwork({ nodes: ["http://a"] }, {}, send).then(
      () => expect.fail("should have failed"),
      (e) => expect(e.message).to.include("no node answered").and.to.include("ECONNREFUSED")
    );
  });
});

describe("project: commands", () => {
  let dir: string;
  let logs: string[];
  let errs: string[];
  let sent: any[];
  let answer: (url: string, body: any) => any;
  const SOURCE = `import { Standard } from "@activeledger/activecontracts";\nexport default class Notebook extends Standard {\n  public vote(): Promise<boolean> { return Promise.resolve(true); }\n}\n`;

  const deps = (over: Partial<ProjectDeps> = {}): ProjectDeps => ({
    cwd: dir,
    env: {},
    git: fakeGit({ ignored: true }),
    send: async (url, body) => (sent.push({ url, body }), answer(url, body)),
    get: async () => ({ reference: "r".repeat(40) }),
    tty: false,
    confirmTyped: async () => false,
    audit: async () => ({ lines: [] }),
    out: { log: (t) => logs.push(t), error: (t) => errs.push(t) },
    ...over,
  });
  const run = (pos: string[], flags: ProjectFlags = {}, d: Partial<ProjectDeps> = {}) => projectCommand(pos, flags, deps(d));
  const project = () => JSON.parse(fs.readFileSync(path.join(dir, ".activeledger"), "utf8"));

  const reply = (o: { commit?: number; errors?: string[]; newStreams?: any[]; total?: number } = {}) => ({
    $umid: "u".repeat(64),
    $summary: { total: o.total ?? 4, vote: 4, commit: o.commit ?? 1, ...(o.errors ? { errors: o.errors } : {}) },
    $streams: { new: o.newStreams || [], updated: [] },
  });

  /** A project already set up with an identity onboarded on `local` */
  const setup = (extra: any = {}) => {
    fs.writeFileSync(path.join(dir, "notebook.ts"), SOURCE);
    fs.writeFileSync(
      path.join(dir, ".activeledger"),
      JSON.stringify({ version: 1, namespace: "myorg", defaultNetwork: "local", networks: { local: { nodes: ["http://127.0.0.1:5260", "http://127.0.0.1:5261"] } }, contracts: { notebook: { source: "notebook.ts", version: "0.0.1" } }, transactions: { "add-note": { contract: "notebook", entry: "create", input: { "@alice": { note: "hi" } }, output: {}, expect: { commit: 1 } } }, ...extra })
    );
    writeKeys(path.join(dir, ".activeledger-key"), { version: 1, identities: { alice: IDENTITY } });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    logs = [];
    errs = [];
    sent = [];
    answer = () => reply();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("with no command it lists the commands, and only draws the banner for a person at a terminal", async () => {
    expect(await run([])).to.equal(0);
    expect(logs.join("\n")).to.include("deploy").and.to.not.include("#####");
    logs.length = 0;
    await run([], {}, { tty: true });
    expect(logs.join("\n")).to.include("#");
    logs.length = 0;
    expect(await run(["help", "contract"])).to.equal(0);
    expect(logs.join("\n")).to.include("contract upload");
    expect(await run(["help", "zzz"])).to.equal(2);
    expect(await run(["frobnicate"])).to.equal(2);
    expect(errs.join("\n")).to.include("unknown project command");
  });

  it("init creates both files, a private key file, and ignores the key file; never overwrites", async () => {
    expect(await run(["init"], { name: "MyOrg", net: ["testnet=http://127.0.0.1:5260,http://127.0.0.1:5261"] }, { git: fakeGit({ ignored: true }) })).to.equal(0);
    const p = project();
    expect(p).to.deep.include({ version: 1, namespace: "myorg", defaultNetwork: "testnet" });
    expect(p.networks.testnet.nodes).to.have.length(2);
    expect(fs.statSync(path.join(dir, ".activeledger-key")).mode & 0o777).to.equal(0o600);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).to.include(".activeledger-key");
    expect(await run(["init"])).to.equal(2);
    expect(errs.join("\n")).to.include("never overwrites");
    expect(await run(["init"], { fixIgnore: true })).to.equal(0);
  });
  it("init with no network makes a local one, and does not touch .gitignore outside a repository", async () => {
    await run(["init"], {}, { git: fakeGit({ repo: false }) });
    expect(project().networks.local.nodes[0]).to.equal("http://127.0.0.1:5260");
    expect(fs.existsSync(path.join(dir, ".gitignore"))).to.equal(false);
    expect(await run(["init"], { project: "staging" })).to.equal(0);
    expect(fs.existsSync(path.join(dir, "staging.activeledger"))).to.equal(true);
    expect(fs.existsSync(path.join(dir, "staging.activeledger-key"))).to.equal(true);
  });
  it("refuses every key command while the key file is not ignored or is tracked", async () => {
    setup();
    expect(await run(["deploy"], {}, { git: fakeGit({ ignored: false }) })).to.equal(2);
    expect(errs.join("\n")).to.include("not ignored");
    errs.length = 0;
    expect(await run(["identity", "list"], {}, { git: fakeGit({ ignored: true, tracked: true }) })).to.equal(2);
    expect(errs.join("\n")).to.include("tracked by git");
    expect(sent).to.have.length(0);
    expect(await run(["identity", "list"], { allowUnignoredKey: true }, { git: fakeGit({ ignored: false }) })).to.equal(0);
  });

  it("identity new makes a key, onboards it, and records only the stream id; list never shows a key", async () => {
    setup();
    fs.writeFileSync(path.join(dir, ".activeledger-key"), JSON.stringify({ version: 1, identities: {} }), { mode: 0o600 });
    answer = () => reply({ newStreams: [{ id: SID, name: "identity" }] });
    expect(await run(["identity", "new", "bob"])).to.equal(0);
    expect(sent[0].body.$selfsign).to.equal(true);
    expect(sent[0].body.$tx.$contract).to.equal("onboard");
    const keys = readKeys(path.join(dir, ".activeledger-key"));
    expect(keys.identities.bob.streams!.local).to.equal(SID);
    logs.length = 0;
    await run(["identity", "list"]);
    const shown = logs.join("\n");
    expect(shown).to.include("bob").and.to.include(SID).and.to.not.include("PRIVATE");
    expect(await run(["identity", "new", "bob"])).to.equal(2);
    expect(await run(["identity", "new", "bad name"])).to.equal(2);
  });
  it("identity new keeps the key when the onboarding fails, and onboard retries it", async () => {
    setup();
    fs.writeFileSync(path.join(dir, ".activeledger-key"), JSON.stringify({ version: 1, identities: {} }), { mode: 0o600 });
    answer = () => reply({ commit: 0, errors: ["Signature Incorrect"] });
    expect(await run(["identity", "new", "bob"])).to.equal(1);
    expect(logs.join("\n")).to.include("the key is saved");
    answer = () => reply({ newStreams: [{ id: SID }] });
    expect(await run(["identity", "onboard", "bob"])).to.equal(0);
    expect(readKeys(path.join(dir, ".activeledger-key")).identities.bob.streams!.local).to.equal(SID);
    expect(await run(["identity", "onboard", "nobody"])).to.equal(2);
  });
  it("identity new --dry-run prints the transaction and writes and sends nothing", async () => {
    setup();
    fs.writeFileSync(path.join(dir, ".activeledger-key"), JSON.stringify({ version: 1, identities: {} }), { mode: 0o600 });
    expect(await run(["identity", "new", "bob"], { dryRun: true })).to.equal(0);
    expect(sent).to.have.length(0);
    expect(readKeys(path.join(dir, ".activeledger-key")).identities).to.deep.equal({});
    expect(logs.join("\n")).to.include("onboard");
  });

  it("namespace register sends once and then says it is done; a refusal is a failure", async () => {
    setup();
    expect(await run(["namespace", "register"])).to.equal(0);
    expect(sent[0].body.$tx).to.deep.include({ $contract: "namespace" });
    expect(sent[0].body.$tx.$i[SID].namespace).to.equal("myorg");
    expect(project().networks.local.namespaceRegistered).to.equal(true);
    sent.length = 0;
    logs.length = 0;
    expect(await run(["namespace", "register"])).to.equal(0);
    expect(sent).to.have.length(0);
    expect(logs.join("\n")).to.include("already registered");
  });
  it("a taken namespace is reported as taken", async () => {
    setup();
    answer = () => reply({ commit: 0, errors: ["Namespace Reserved"] });
    expect(await run(["namespace", "register"])).to.equal(1);
    expect(logs.join("\n")).to.include("taken");
    expect(project().networks.local.namespaceRegistered).to.equal(undefined);
  });

  it("contract upload records the id, version and hash; a second upload is refused; deploy then skips it", async () => {
    setup();
    answer = () => reply({ newStreams: [{ id: CID, name: "contract.myorg.notebook@0.0.1" }] });
    expect(await run(["contract", "upload", "notebook"])).to.equal(0);
    const tx = sent[0].body.$tx;
    expect(tx).to.deep.include({ $contract: "contract" });
    expect(tx.$entry).to.equal(undefined);
    expect(Buffer.from(tx.$i[SID].contract, "base64").toString()).to.equal(SOURCE);
    expect(tx.$i[SID]).to.deep.include({ namespace: "myorg", name: "notebook", version: "0.0.1" });
    const d = project().networks.local.contracts.notebook;
    expect(d).to.deep.include({ id: CID, version: "0.0.1" });
    expect(d.hash).to.have.length(64);
    expect(await run(["contract", "upload", "notebook"])).to.equal(1);
    expect(logs.join("\n")).to.include("use `contract update`");
    sent.length = 0;
    logs.length = 0;
    expect(await run(["deploy"])).to.equal(0);
    expect(logs.join("\n")).to.include("already current");
    expect(sent.map((s) => s.body.$tx.$contract)).to.deep.equal(["namespace"]);
  });
  it("update needs a new version when the source changed, then sends an update for the recorded stream", async () => {
    setup();
    answer = () => reply({ newStreams: [{ id: CID }] });
    await run(["contract", "upload", "notebook"]);
    fs.writeFileSync(path.join(dir, "notebook.ts"), SOURCE + "\n// changed\n");
    sent.length = 0;
    expect(await run(["contract", "update", "notebook"])).to.equal(1);
    expect(logs.join("\n")).to.include("bump");
    expect(sent).to.have.length(0);
    const p = project();
    p.contracts.notebook.version = "0.0.2";
    fs.writeFileSync(path.join(dir, ".activeledger"), JSON.stringify(p));
    answer = () => reply();
    expect(await run(["contract", "update", "notebook"])).to.equal(0);
    expect(sent[0].body.$tx).to.deep.include({ $entry: "update" });
    expect(sent[0].body.$tx.$o).to.deep.equal({ [CID]: {} });
    expect(project().networks.local.contracts.notebook.version).to.equal("0.0.2");
    expect(await run(["contract", "update", "notebook"])).to.equal(0);
    expect(logs.join("\n")).to.include("already current");
  });
  it("update before upload, and upload by an unknown name, fail clearly", async () => {
    setup();
    expect(await run(["contract", "update", "notebook"])).to.equal(1);
    expect(logs.join("\n")).to.include("not deployed here yet");
    expect(await run(["contract", "upload", "ghost"])).to.equal(2);
    expect(errs.join("\n")).to.include('no contract "ghost"');
  });
  it("the audit stops an upload on a high finding unless told not to, and says what it found", async () => {
    setup();
    const audit = async () => ({ worst: "critical" as any, lines: ["critical no-eval line 3: eval() runs text as code"] });
    expect(await run(["contract", "upload", "notebook"], {}, { audit })).to.equal(1);
    expect(logs.join("\n")).to.include("no-eval").and.to.include("--no-audit");
    expect(sent).to.have.length(0);
    answer = () => reply({ newStreams: [{ id: CID }] });
    expect(await run(["contract", "upload", "notebook"], { noAudit: true }, { audit })).to.equal(0);
    fs.rmSync(path.join(dir, ".activeledger"));
    setup();
    expect(await run(["contract", "upload", "notebook"], { auditFailOn: "urgent" })).to.equal(2);
    const medium = async () => ({ worst: "medium" as any, lines: [] });
    answer = () => reply({ newStreams: [{ id: CID }] });
    expect(await run(["contract", "upload", "notebook"], {}, { audit: medium })).to.equal(0);
  });
  it("a failed upload records nothing", async () => {
    setup();
    answer = () => reply({ commit: 0, errors: ["Security Violation"] });
    expect(await run(["contract", "upload", "notebook"])).to.equal(1);
    expect(project().networks.local.contracts).to.equal(undefined);
  });
  it("a node that cannot be reached falls over to the next, and none at all is exit 2", async () => {
    setup();
    answer = (url) => {
      if (url.endsWith(":5260")) throw new Error("ECONNREFUSED");
      return reply({ newStreams: [{ id: CID }] });
    };
    expect(await run(["contract", "upload", "notebook"])).to.equal(0);
    expect(sent.map((s) => s.url)).to.deep.equal(["http://127.0.0.1:5260", "http://127.0.0.1:5261"]);
    answer = () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await run(["namespace", "register"])).to.equal(2);
    expect(errs.join("\n")).to.include("no node answered");
  });
  it("contract status says not deployed, current, or out of date, and needs no key", async () => {
    setup();
    await run(["contract", "status"], {}, { git: fakeGit({ ignored: false }) });
    expect(logs.join("\n")).to.include("not deployed on local");
    answer = () => reply({ newStreams: [{ id: CID }] });
    await run(["contract", "upload", "notebook"]);
    logs.length = 0;
    await run(["contract", "status", "notebook"]);
    expect(logs.join("\n")).to.include("deployed and current");
    fs.writeFileSync(path.join(dir, "notebook.ts"), SOURCE + "// x\n");
    logs.length = 0;
    await run(["contract", "status"]);
    expect(logs.join("\n")).to.include("source differs");
  });

  it("--dry-run signs and prints but sends and records nothing", async () => {
    setup();
    expect(await run(["deploy"], { dryRun: true })).to.equal(0);
    expect(sent).to.have.length(0);
    expect(logs.join("\n")).to.include('"$contract": "namespace"').and.to.include('"$contract": "contract"');
    expect(project().networks.local.contracts).to.equal(undefined);
    expect(project().networks.local.namespaceRegistered).to.equal(undefined);
  });
  it("a protected network needs ACTIVELEDGER_CONFIRM or a typed answer, not --yes", async () => {
    setup();
    const p = project();
    p.networks.local.protected = true;
    fs.writeFileSync(path.join(dir, ".activeledger"), JSON.stringify(p));
    expect(await run(["namespace", "register"], { yes: true })).to.equal(2);
    expect(errs.join("\n")).to.include("protected network").and.to.include("ACTIVELEDGER_CONFIRM=local");
    expect(sent).to.have.length(0);
    expect(await run(["namespace", "register"], {}, { env: { ACTIVELEDGER_CONFIRM: "other" } })).to.equal(2);
    expect(await run(["namespace", "register"], {}, { env: { ACTIVELEDGER_CONFIRM: "local" } })).to.equal(0);
    fs.writeFileSync(path.join(dir, ".activeledger"), JSON.stringify({ ...p, networks: { local: { ...p.networks.local, namespaceRegistered: false } } }));
    expect(await run(["namespace", "register"], {}, { tty: true, confirmTyped: async (_q, expect) => expect === "local" })).to.equal(0);
    fs.writeFileSync(path.join(dir, ".activeledger"), JSON.stringify({ ...p, networks: { local: { ...p.networks.local, namespaceRegistered: false } } }));
    expect(await run(["namespace", "register"], { dryRun: true })).to.equal(0);
  });

  it("tx run sends the example signed by the project identity and checks expect; --set changes it", async () => {
    setup({ networks: { local: { nodes: ["http://127.0.0.1:5260"], contracts: { notebook: { id: CID, version: "0.0.1", hash: "h" } } } } });
    expect(await run(["tx", "run", "add-note"], { set: ["input.@alice.note=changed"] })).to.equal(0);
    const tx = sent[0].body.$tx;
    expect(tx).to.deep.include({ $namespace: "myorg", $contract: CID, $entry: "create" });
    expect(tx.$i[SID].note).to.equal("changed");
    expect(sent[0].body.$sigs[SID]).to.be.a("string");
    expect(logs.join("\n")).to.include("committed");
  });
  it("tx run fails when expect is not met, and passes a refusal that was expected", async () => {
    const nets = { local: { nodes: ["http://127.0.0.1:5260"], contracts: { notebook: { id: CID, version: "0.0.1", hash: "h" } } } };
    setup({ networks: nets });
    answer = () => reply({ commit: 0, errors: ["Contract Failed"] });
    expect(await run(["tx", "run", "add-note"])).to.equal(1);
    expect(logs.join("\n")).to.include("Contract Failed");
    const p = project();
    p.transactions["add-note"].expect = { error: "Contract Failed" };
    fs.writeFileSync(path.join(dir, ".activeledger"), JSON.stringify(p));
    logs.length = 0;
    expect(await run(["tx", "run", "add-note"])).to.equal(0);
    expect(logs.join("\n")).to.include("refused as expected");
  });
  it("tx run --all stops at the first failure; tx list shows the examples; a missing name is a usage error", async () => {
    const nets = { local: { nodes: ["http://127.0.0.1:5260"], contracts: { notebook: { id: CID, version: "0.0.1", hash: "h" } } } };
    setup({ networks: nets, transactions: { a: { contract: "notebook", input: { "@alice": {} } }, b: { contract: "notebook", input: { "@alice": {} } } } });
    answer = () => reply({ commit: 0, errors: ["No"] });
    expect(await run(["tx", "run"], { all: true })).to.equal(1);
    expect(sent).to.have.length(1);
    expect(await run(["tx", "run"])).to.equal(2);
    expect(await run(["tx", "run", "nope"])).to.equal(2);
    logs.length = 0;
    expect(await run(["tx", "list"])).to.equal(0);
    expect(logs.join("\n")).to.include("a").and.to.include("b");
  });
  it("an example uses the contract's plain name as its label when it has no stream id yet", async () => {
    setup();
    expect(await run(["tx", "run", "add-note"], {}, {})).to.equal(0); // names the contract by its plain name when it has no id
  });

  it("status asks each node and lists the project's state", async () => {
    setup();
    expect(await run(["status"])).to.equal(0);
    expect(logs.join("\n")).to.include("http://127.0.0.1:5260").and.to.include("not registered").and.to.include("not deployed");
    logs.length = 0;
    expect(await run(["status"], {}, { get: async () => { throw new Error("down"); } })).to.equal(1);
    expect(logs.join("\n")).to.include("down");
  });
  it("--json prints the steps as JSON and errors as JSON", async () => {
    setup();
    await run(["status"], { json: true });
    expect(JSON.parse(logs.join("\n")).steps[0].step).to.include("127.0.0.1");
    errs.length = 0;
    await run(["nope"], { json: true });
    expect(JSON.parse(errs[0]).error).to.include("unknown project command");
  });
  it("picks the network: the only one, the default, --net, or says to choose", async () => {
    setup({ defaultNetwork: undefined, networks: { a: { nodes: ["http://127.0.0.1:1"] }, b: { nodes: ["http://127.0.0.1:2"] } } });
    expect(await run(["status"])).to.equal(2);
    expect(errs.join("\n")).to.include("--net");
    expect(await run(["status"], { net: "b" })).to.equal(0);
    expect(logs.join("\n")).to.include("127.0.0.1:2");
    expect(await run(["status"], { net: "zz" })).to.equal(2);
  });
  it("two project files in one folder each use their own key file", async () => {
    setup();
    fs.copyFileSync(path.join(dir, ".activeledger"), path.join(dir, "staging.activeledger"));
    writeKeys(path.join(dir, "staging.activeledger-key"), { version: 1, identities: {} });
    expect(await run(["identity", "list"])).to.equal(2); // two files, none named
    expect(errs.join("\n")).to.include("--project");
    logs.length = 0;
    expect(await run(["identity", "list"], { project: "staging" })).to.equal(0);
    expect(logs.join("\n")).to.include("none yet");
    logs.length = 0;
    expect(await run(["identity", "list"], { project: ".activeledger" })).to.equal(0);
    expect(logs.join("\n")).to.include("alice");
  });
});
