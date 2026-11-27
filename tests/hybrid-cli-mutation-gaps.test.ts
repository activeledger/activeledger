import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import { hybridCommand } from "../packages/activeledger/src/cli/hybrid";
import { reloadCommand } from "../packages/activeledger/src/cli/reload";

/**
 * Edges a mutation pass over the `hybrid` and `reload` commands found nothing
 * checking: what each subcommand sends, what it exits with, and what it tells
 * the operator, against a node that answers as a real one does.
 */
describe("activeledger hybrid and reload commands - edges the tests did not pin (Activeledger CLI)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-cli-"));
  const hash = (c: string) => c.repeat(64);
  let server: http.Server;
  let port: number;
  let calls: { method: string; url: string; body: any }[];
  let answers: { [url: string]: { status?: number; body: any } };
  let host: string;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          // not JSON
        }
        calls.push({ method: req.method!, url: req.url!, body });
        const a = answers[req.url!] ?? { body: { $summary: { commit: 1 } } };
        res.statusCode = a.status ?? 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as any).port;
    host = `127.0.0.1:${port}`;
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ host, network: "net@1-abc" }));
    fs.writeFileSync(path.join(dir, ".identity"), JSON.stringify(new ActiveCrypto.KeyPair("rsa").generate()));
  });
  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Put each option back exactly as it was, including not being there at all
  const KEYS = ["config", "identity", "host", "port"];
  const saved: { [k: string]: { had: boolean; value: any } } = {};
  beforeEach(() => {
    calls = [];
    answers = {};
    const held: any = ActiveOptions.fetch(false);
    for (const k of KEYS) saved[k] = { had: k in held, value: held[k] };
    ActiveOptions.set("config", path.join(dir, "config.json"));
    ActiveOptions.set("identity", path.join(dir, ".identity"));
    ActiveOptions.set("host", "");
    ActiveOptions.set("port", "");
  });
  afterEach(() => {
    const held: any = ActiveOptions.fetch(false);
    for (const k of KEYS) {
      if (saved[k].had) held[k] = saved[k].value;
      else delete held[k];
    }
  });

  const run = async (sub: string | undefined, arg?: string, json = false, outFile?: string, arg2?: string) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await hybridCommand(sub, arg, json, { log: (t) => logs.push(t), error: (t) => errors.push(t) }, outFile, arg2);
    return { code, logs, errors };
  };
  const posted = () => calls.filter((c) => c.method === "POST" && c.url === "/");
  const changeOf = (c: any) => c.body.$tx.$i.suggester.change;

  describe("changes to the rules", () => {
    const cases: [string, string, any][] = [
      ["admission", "open", { admission: "open" }],
      ["admission", "allowlist", { admission: "allowlist" }],
      ["allow", hash("a"), { allow: [hash("a")] }],
      ["deny", hash("b"), { deny: [hash("b")] }],
      ["min-version", "5.1.1", { minVersion: "5.1.1" }],
    ];
    for (const [sub, arg, change] of cases) {
      it(`${sub} ${arg.slice(0, 8)} sends that change, signed, and says it was applied`, async () => {
        const r = await run(sub, arg);
        expect(r.code).to.equal(0);
        expect(r.logs).to.deep.equal(["applied to the ledger"]);
        expect(posted()).to.have.length(1);
        const tx = posted()[0].body;
        expect(changeOf(posted()[0])).to.deep.equal(change);
        expect(tx.$tx.$entry).to.equal("hybrid");
        expect(tx.$tx.$o).to.have.all.keys("net");
        expect(tx.$sigs[host]).to.be.a("string");
        expect(tx.$sigs.suggester).to.equal(tx.$sigs[host]);
      });
    }

    it("reports success as JSON on request", async () => {
      const r = await run("admission", "open", true);
      expect(r.logs).to.deep.equal([JSON.stringify({ ok: true })]);
    });

    it("shows the node's reasons and exits 1 when it does not apply a change", async () => {
      answers["/"] = { body: { $summary: { errors: ["no", "never"] } } };
      const r = await run("admission", "open");
      expect(r.code).to.equal(1);
      expect(r.errors).to.deep.equal(["not applied: no; never"]);
    });

    it("says what is missing for each subcommand that takes an argument", async () => {
      for (const sub of ["allow", "deny", "admission", "min-version", "ban", "unban", "sign", "submit"]) {
        const r = await run(sub);
        expect([sub, r.code, r.errors.length]).to.deep.equal([sub, 1, 1]);
      }
      expect((await run("allow")).errors[0]).to.contain("key");
      expect((await run("admission")).errors[0]).to.contain("a value");
      expect(posted()).to.have.length(0);
    });

    it("writes a signed change to a file instead of sending it with --out, for the other nodes to sign", async () => {
      const file = path.join(dir, "change.json");
      const r = await run("admission", "open", false, file);
      expect(r.code).to.equal(0);
      expect(r.logs[0]).to.contain(file).and.contain("hybrid sign");
      expect(calls).to.have.length(0);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(written.$tx.$i.suggester.change).to.deep.equal({ admission: "open" });
      expect(written.$sigs[host]).to.be.a("string");
    });

    it("adds this node's signature to a file with sign, and sends one with submit", async () => {
      const file = path.join(dir, "signme.json");
      await run("min-version", "5.2.0", false, file);
      const before = JSON.parse(fs.readFileSync(file, "utf8"));
      before.$sigs["other:1"] = "theirs";
      delete before.$sigs[host];
      fs.writeFileSync(file, JSON.stringify(before));

      const signed = await run("sign", file);
      expect(signed.code).to.equal(0);
      expect(signed.logs[0]).to.contain("signed by").and.contain(host).and.contain("other:1");
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(after.$sigs[host]).to.be.a("string");
      expect(JSON.parse((await run("sign", file, true)).logs[0]).signers).to.have.members([host, "other:1"]);

      const sent = await run("submit", file);
      expect(sent.code).to.equal(0);
      expect(posted()).to.have.length(1);
      expect(posted()[0].body.$sigs["other:1"]).to.equal("theirs");
      answers["/"] = { body: { $summary: { errors: ["short of signatures"] } } };
      expect((await run("submit", file)).code).to.equal(1);
    });
  });

  describe("enable", () => {
    const status = (over: any = {}) => ({ enabled: false, buildOk: true, build: 40300, requiredBuild: 40300, ...over });

    it("sends a change that creates the section, closed unless told to open it, and says what to do next", async () => {
      answers["/a/hybrid/status"] = { body: status() };
      const closed = await run("enable");
      expect(closed.code).to.equal(0);
      expect(changeOf(posted()[0])).to.deep.equal({ enable: true, admission: "allowlist" });
      expect(closed.logs[0]).to.contain("applied to the ledger").and.contain("now enabled").and.contain("hybrid allow");

      calls = [];
      const open = await run("enable", "open");
      expect(changeOf(posted()[0])).to.deep.equal({ enable: true, admission: "open" });
      expect(open.logs[0]).to.contain("now enabled").and.not.contain("hybrid allow");
    });

    it("refuses an admission that is empty or not one it knows", async () => {
      answers["/a/hybrid/status"] = { body: status() };
      for (const bad of ["", "closed"]) {
        const r = await run("enable", bad);
        expect([bad, r.code]).to.deep.equal([bad, 1]);
      }
      expect(posted()).to.have.length(0);
    });

    it("writes the change to a file with --out and sends nothing", async () => {
      answers["/a/hybrid/status"] = { body: status() };
      const file = path.join(dir, "enable.json");
      const r = await run("enable", undefined, false, file);
      expect(r.code).to.equal(0);
      expect(posted()).to.have.length(0);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).$tx.$i.suggester.change).to.deep.equal({ enable: true, admission: "allowlist" });
    });

    it("exits 1 with the node's reasons when the change is refused", async () => {
      answers["/a/hybrid/status"] = { body: status() };
      answers["/"] = { body: { $summary: { errors: ["Host node signature problem"] } } };
      const r = await run("enable");
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain("Host node signature problem");
    });
  });

  describe("status", () => {
    const st = (over: any) => ({ enabled: true, buildOk: true, build: 40300, requiredBuild: 40300, admission: "open", minVersion: "5.1.0", registered: 1, retired: 0, feeds: { count: 0, max: 32 }, signing: "rsa", attestKeyHeld: false, ...over });
    it("suggests listing the Ed25519 key only when one is held and RSA is signing", async () => {
      for (const [signing, held, hint] of [["rsa", true, true], ["rsa", false, false], ["ed25519", true, false], ["off", true, false]] as const) {
        answers["/a/hybrid/status"] = { body: st({ signing, attestKeyHeld: held }) };
        const out = (await run("status")).logs[0];
        expect([signing, held, out.includes('add "attest"')]).to.deep.equal([signing, held, hint]);
      }
    });
  });

  describe("ban and unban", () => {
    it("say what they did, as JSON on request, and exit 0", async () => {
      expect((await run("ban", hash("a"))).logs).to.deep.equal([`banned ${hash("a")}`]);
      expect((await run("unban", hash("a"))).logs).to.deep.equal([`unbanned ${hash("a")}`]);
      expect(JSON.parse((await run("ban", hash("a"), true)).logs[0])).to.deep.equal({ ok: true });
    });
    it("exit 1 with the node's own reason when it refuses (a 400 and an error)", async () => {
      answers["/a/hybrid/ban"] = { status: 400, body: { error: "unknown or invalid key hash" } };
      for (const sub of ["ban", "unban"]) {
        answers[`/a/hybrid/${sub}`] = answers["/a/hybrid/ban"];
        const r = await run(sub, "zzz");
        expect([sub, r.code, r.errors, r.logs]).to.deep.equal([sub, 1, ["unknown or invalid key hash"], []]);
      }
    });
    it("exit 1 when the node answers nothing at all", async () => {
      answers["/a/hybrid/ban"] = { body: null };
      const r = await run("ban", hash("a"));
      expect([r.code, r.errors]).to.deep.equal([1, ["ban failed"]]);
    });
  });

  describe("tier and untier", () => {
    it("send the key, and the tier when given, and say what they did", async () => {
      expect((await run("tier", hash("a"))).logs).to.deep.equal([`${hash("a")} is premium`]);
      expect(calls[0]).to.deep.include({ method: "POST", url: "/a/hybrid/tier" });
      expect(calls[0].body).to.deep.equal({ keyHash: hash("a") });
      expect((await run("tier", hash("a"), false, undefined, "2")).logs).to.deep.equal([`${hash("a")} is premium, tier 2`]);
      expect(calls[1].body).to.deep.equal({ keyHash: hash("a"), tier: 2 });
      expect((await run("untier", hash("a"))).logs).to.deep.equal([`${hash("a")} is free`]);
      expect(calls[2].url).to.equal("/a/hybrid/untier");
    });
    it("need a key hash, and exit 1 with the node's reason when it refuses", async () => {
      expect((await run("tier")).errors).to.deep.equal(["hybrid tier needs a key hash"]);
      answers["/a/hybrid/untier"] = { status: 400, body: { error: "unknown or invalid key hash or tier" } };
      const r = await run("untier", "zzz");
      expect([r.code, r.errors]).to.deep.equal([1, ["unknown or invalid key hash or tier"]]);
    });
    it("show the tier in the list and in the feeds", async () => {
      answers["/a/hybrid/list"] = { body: [{ keyHash: hash("a"), label: "A", endpoints: [], tier: 1, feedConnected: true }] };
      expect((await run("list")).logs[0]).to.contain("tier 1").and.contain("feed");
      answers["/a/hybrid/feeds"] = { body: { count: 1, max: 32, premiumSlots: 12, feeds: [{ keyHash: hash("a"), cursor: "", connectedSeconds: 3, tier: 0 }] } };
      const r = await run("feeds");
      expect(r.logs[0]).to.contain("1 of 32 feeds (12 kept for premium)").and.contain("tier 0");
    });
  });

  describe("feeds", () => {
    it("lists the connected feeds and exits 0", async () => {
      answers["/a/hybrid/feeds"] = { body: { count: 1, max: 32, feeds: [{ keyHash: hash("a"), cursor: "", connectedSeconds: 3 }] } };
      const r = await run("feeds");
      expect(r.code).to.equal(0);
      expect(r.logs[0]).to.contain("1 of 32").and.contain("at start");
    });
  });

  describe("finding the node", () => {
    it("takes the port from config.json when only a host is given", async () => {
      ActiveOptions.set("host", "127.0.0.1");
      answers["/a/hybrid/list"] = { body: [] };
      const r = await run("list");
      expect(r.code).to.equal(0);
      expect(calls[0].url).to.equal("/a/hybrid/list");
    });
  });

  describe("reload", () => {
    it("exits 2 when the node answers nothing", async () => {
      ActiveOptions.set("host", "127.0.0.1");
      answers["/a/admin-reload"] = { status: 200, body: null };
      const errors: string[] = [];
      const code = await reloadCommand(false, { log: () => undefined, error: (t) => errors.push(t) });
      expect([code, errors]).to.deep.equal([2, ["could not reach the node"]]);
    });
  });
});
