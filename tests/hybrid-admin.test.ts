import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { HybridBans, feedsStatus, isLoopback, listHybrids } from "../packages/network/src/network/hybridAdmin";
import { hybridCommand } from "../packages/activeledger/src/cli/hybrid";
import { reloadCommand } from "../packages/activeledger/src/cli/reload";
import { ActiveOptions } from "@activeledger/activeoptions";

const hash = (c: string) => c.repeat(64);

describe("hybrid bans", () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bans-")), "bans.json");

  it("bans, unbans and survives a restart", () => {
    const f = file();
    const a = new HybridBans(f);
    expect(a.ban(hash("a"))).to.equal(true);
    expect(a.set().has(hash("a"))).to.equal(true);
    expect(new HybridBans(f).set().has(hash("a"))).to.equal(true);
    expect(a.unban(hash("a"))).to.equal(true);
    expect(new HybridBans(f).set().size).to.equal(0);
  });

  it("refuses anything that is not a key hash, and unban is idempotent", () => {
    const b = new HybridBans(file());
    for (const bad of ["", "xyz", hash("g"), undefined as any, 5 as any]) {
      expect(b.ban(bad)).to.equal(false);
      expect(b.unban(bad)).to.equal(false);
    }
    expect(b.unban(hash("b"))).to.equal(true);
  });

  it("ignores a corrupt or hostile file", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify([hash("a"), "junk", 5]));
    expect([...new HybridBans(f).set()]).to.deep.equal([hash("a")]);
    fs.writeFileSync(f, "not json");
    expect(new HybridBans(f).set().size).to.equal(0);
  });
});

describe("hybrid admin views", () => {
  it("only trusts loopback", () => {
    for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.5.5.5"]) expect(isLoopback(ok), ok).to.equal(true);
    for (const bad of ["10.0.0.1", "192.168.1.1", "::ffff:10.0.0.1", "", undefined, "1127.0.0.1"]) expect(isLoopback(bad as any), String(bad)).to.equal(false);
  });

  it("lists hybrids with their feed, ban and retired state", async () => {
    const registry: any = {
      list: async () => [
        { keyHash: hash("a"), key: "k", type: "rsa", endpoints: [], label: "x" },
        { keyHash: hash("b"), key: "k", type: "rsa", endpoints: [], retired: true },
      ],
    };
    const feeds: any = new Set([{ keyHash: hash("a"), since: "", connectedAt: 0 }]);
    const rows = await listHybrids(registry, feeds, new Set([hash("b")]));
    expect(rows[0]).to.include({ keyHash: hash("a"), feedConnected: true, banned: false, retired: false });
    expect(rows[1]).to.include({ feedConnected: false, banned: true, retired: true });
  });

  it("reports feeds against the cap with their live cursor", () => {
    const feeds: any = new Set([{ keyHash: hash("a"), since: "s", cursor: "umid:5,u", connectedAt: 1000 }]);
    expect(feedsStatus(feeds, 32, 11_000)).to.deep.equal({
      count: 1,
      max: 32,
      feeds: [{ keyHash: hash("a"), cursor: "umid:5,u", connectedSeconds: 10 }],
    });
  });
});

describe("activeledger hybrid command", () => {
  let server: http.Server;
  let calls: { method: string; url: string; body: string }[];
  let port: number;
  let statusAnswer: any;
  let reloadAnswer: any;
  const status = (over: any = {}) => ({
    enabled: false, build: 40300, buildOk: true, requiredBuild: 40300, registered: 0, retired: 0,
    feeds: { count: 0, max: 32 }, signing: "off", attestKeyHeld: true, ...over,
  });

  beforeEach(async () => {
    calls = [];
    statusAnswer = status();
    reloadAnswer = { status: "success", build: 40300 };
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method!, url: req.url!, body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/a/hybrid/list") res.end(JSON.stringify([{ keyHash: hash("a"), label: "l", endpoints: [{ transport: "p2p", host: "h", port: 1 }], feedConnected: true }]));
        else if (req.url === "/a/hybrid/feeds") res.end(JSON.stringify({ count: 1, max: 32, feeds: [{ keyHash: hash("a"), cursor: "", connectedSeconds: 3 }] }));
        else if (req.url === "/a/admin-reload") res.end(JSON.stringify(reloadAnswer));
        else if (req.url === "/a/hybrid/status") res.end(JSON.stringify(statusAnswer));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as any).port;
    ActiveOptions.init();
    ActiveOptions.set("host", "127.0.0.1");
    ActiveOptions.set("port", String(port));
  });
  afterEach(() => {
    server.close();
    ActiveOptions.set("host", "");
    ActiveOptions.set("port", "");
  });

  const run = async (sub: string | undefined, arg?: string, json = false) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await hybridCommand(sub, arg, json, { log: (t) => logs.push(t), error: (t) => errors.push(t) });
    return { code, logs, errors };
  };

  it("lists and shows feeds", async () => {
    const list = await run("list");
    expect(list.code).to.equal(0);
    expect(list.logs[0]).to.contain(hash("a")).and.contain("p2p://h:1").and.contain("feed");
    const feeds = await run("feeds");
    expect(feeds.logs[0]).to.contain("1 of 32 feeds");
    expect(JSON.parse((await run("feeds", undefined, true)).logs[0]).count).to.equal(1);
  });

  it("sends a ban and an unban with the key hash", async () => {
    expect((await run("ban", hash("a"))).code).to.equal(0);
    expect((await run("unban", hash("a"))).code).to.equal(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.url)).to.deep.equal(["/a/hybrid/ban", "/a/hybrid/unban"]);
    expect(JSON.parse(posts[0].body)).to.deep.equal({ keyHash: hash("a") });
  });

  it("needs a key hash and a known subcommand", async () => {
    expect((await run("ban")).code).to.equal(1);
    expect((await run(undefined)).code).to.equal(1);
    expect((await run("nope")).code).to.equal(1);
  });

  describe("status and enable", () => {
    it("says hybrids are not enabled and how to turn them on", async () => {
      const r = await run("status");
      expect(r.code).to.equal(0);
      expect(r.logs[0]).to.contain("not enabled").and.contain("activeledger hybrid enable").and.contain("not signing");
    });

    it("says to raise the build first when it is too low", async () => {
      statusAnswer = status({ build: 40250, buildOk: false });
      const r = await run("status");
      expect(r.logs[0]).to.contain("needs 40300").and.contain('Raise "build"');
    });

    it("shows an enabled network: admission, registrations, feeds and the signing key", async () => {
      statusAnswer = status({ enabled: true, admission: "allowlist", allowed: 2, minVersion: "5.1.0", registered: 3, retired: 1, feeds: { count: 1, max: 32 }, signing: "ed25519" });
      const r = (await run("status")).logs[0];
      expect(r).to.contain("enabled on this network").and.contain("allowlist  (2 keys allowed)").and.contain("3  (+1 retired)").and.contain("1 of 32").and.contain("with ed25519");
    });

    it("points at the attest entry when an Ed25519 key is held but RSA is signing", async () => {
      statusAnswer = status({ enabled: true, admission: "open", signing: "rsa", attestKeyHeld: true });
      expect((await run("status")).logs[0]).to.contain('add "attest"');
    });

    it("gives the raw answer with --json", async () => {
      expect(JSON.parse((await run("status", undefined, true)).logs[0]).requiredBuild).to.equal(40300);
    });

    it("enable refuses an admission it does not know, a build that is too low, and a network already enabled", async () => {
      expect((await run("enable", "wide")).code).to.equal(1);
      statusAnswer = status({ buildOk: false, build: 40250 });
      const low = await run("enable");
      expect(low.code).to.equal(1);
      expect(low.errors[0]).to.contain("needs build 40300");
      statusAnswer = status({ enabled: true, admission: "open" });
      const done = await run("enable");
      expect(done.code).to.equal(0);
      expect(done.logs[0]).to.contain("already enabled");
      expect(calls.filter((c) => c.method === "POST")).to.have.length(0);
    });
  });

  describe("reload", () => {
    const reload = async (json = false) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const code = await reloadCommand(json, { log: (t) => logs.push(t), error: (t) => errors.push(t) });
      return { code, logs, errors };
    };

    it("asks the node to re-read its config and reports the build", async () => {
      const r = await reload();
      expect(r.code).to.equal(0);
      expect(r.logs[0]).to.equal("reloaded config.json (build 40300)");
      expect(calls.map((c) => c.url)).to.deep.equal(["/a/admin-reload"]);
      expect(JSON.parse((await reload(true)).logs[0]).status).to.equal("success");
    });

    it("says what to do when the node has remote reload off", async () => {
      reloadAnswer = { status: "failed", message: "remote disabled" };
      const r = await reload();
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain('"remote": true');
    });

    it("reports a reload that failed", async () => {
      reloadAnswer = { status: "failed", message: "bad json" };
      const r = await reload();
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.equal("reload failed: bad json");
    });

    it("exits 2 when the node cannot be reached", async () => {
      server.close();
      ActiveOptions.set("port", "1");
      expect((await reload()).code).to.equal(2);
    });
  });

  it("exits 2 when the node cannot be reached", async () => {
    server.close();
    ActiveOptions.set("port", "1");
    const r = await run("list");
    expect(r.code).to.equal(2);
    expect(r.errors[0]).to.match(/could not reach/);
  });
});
