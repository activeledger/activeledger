import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { checkConfig, init, peers, register, retire, token, update, CommandContext } from "../packages/hybrid/src/commands";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";
import { loadConfig } from "../packages/hybrid/src/config";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-cmd-"));

const make = (dir: string, flags: Record<string, any> = {}, upstream?: any) => {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: CommandContext = {
    flags: { config: path.join(dir, "hybrid.json"), identity: path.join(dir, ".identity"), ...flags },
    out: { log: (t) => logs.push(t), error: (t) => errors.push(t) },
    upstream,
  };
  return { ctx, logs, errors };
};

/** A fake supernode: records submissions, knows nothing until registered */
const fakeSupernode = (state: { registered?: boolean; retired?: boolean; answer?: any } = {}) => {
  const submitted: any[] = [];
  const up: any = {
    id: "fake",
    submitted,
    streams: async (reqs: any[]) => {
      if (!state.registered) throw new UpstreamError("refused", "refused", 403);
      return { docs: [{ _id: reqs[0].id, retired: !!state.retired, endpoints: [] }], missing: [] };
    },
    submit: async (tx: any) => (submitted.push(tx), state.answer ?? { $summary: { commit: 1 } }),
    peers: async () => [{ keyHash: "h1", label: "l", endpoints: [{ transport: "p2p", host: "x", port: 1 }] }],
  };
  return up;
};

describe("activehybrid commands", () => {
  describe("init", () => {
    it("writes a private identity and a valid config from flags", () => {
      const dir = temp();
      const { ctx, logs } = make(dir, { upstream: ["a.example:5260", "b.example:5260:p2p"], port: "5280" });
      expect(init(ctx)).to.equal(0);
      expect((fs.statSync(ctx.flags.identity).mode & 0o777).toString(8)).to.equal("600");
      const cfg = loadConfig(ctx.flags.config);
      expect(cfg.upstreams.map((u) => `${u.host}:${u.port}:${u.transport}`)).to.deep.equal(["a.example:5260:http", "b.example:5260:p2p"]);
      expect(cfg.port).to.equal(5280);
      const id = JSON.parse(fs.readFileSync(ctx.flags.identity, "utf8"));
      expect(logs.join("\n")).to.contain(ActiveCrypto.keyHash(id.pub.pkcs8pem));
    });

    it("refuses to overwrite either file without --force, and overwrites with it", () => {
      const dir = temp();
      expect(init(make(dir).ctx)).to.equal(0);
      const before = fs.readFileSync(path.join(dir, ".identity"), "utf8");
      const again = make(dir);
      expect(init(again.ctx)).to.equal(1);
      expect(again.errors.join()).to.match(/already exist.*--force/);
      expect(fs.readFileSync(path.join(dir, ".identity"), "utf8")).to.equal(before);
      expect(init(make(dir, { force: true }).ctx)).to.equal(0);
      expect(fs.readFileSync(path.join(dir, ".identity"), "utf8")).to.not.equal(before);
    });

    it("writes nothing when a flag is invalid", () => {
      const dir = temp();
      const { ctx, errors } = make(dir, { upstream: "nonsense" });
      expect(init(ctx)).to.equal(1);
      expect(errors).to.have.length(1);
      expect(fs.existsSync(ctx.flags.identity)).to.equal(false);
    });
  });

  it("token prints 64 hex characters, different every time, as JSON on request", () => {
    const a = make(temp());
    const b = make(temp(), { json: true });
    token(a.ctx);
    token(b.ctx);
    expect(a.logs[0]).to.match(/^[0-9a-f]{64}$/);
    expect(JSON.parse(b.logs[0]).token).to.match(/^[0-9a-f]{64}$/);
    expect(a.logs[0]).to.not.equal(JSON.parse(b.logs[0]).token);
  });

  describe("check-config", () => {
    it("exits 0 for a valid file and 2 with the reasons otherwise", () => {
      const dir = temp();
      init(make(dir).ctx);
      expect(checkConfig(make(dir).ctx)).to.equal(0);
      fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ port: 70000, nope: 1 }));
      const bad = make(dir);
      expect(checkConfig(bad.ctx)).to.equal(2);
      expect(bad.errors.join()).to.contain("port").and.contain("unknown key");
      const missing = make(temp());
      expect(checkConfig(missing.ctx)).to.equal(2);
    });
  });

  describe("register / update / retire", () => {
    const ready = (flags: Record<string, any> = {}, state: any = {}) => {
      const dir = temp();
      init(make(dir, { upstream: "s.example:5260" }).ctx);
      const sn = fakeSupernode(state);
      return { sn, ...make(dir, flags, () => sn) };
    };

    it("registers an unknown key with its endpoints and label", async () => {
      const { ctx, sn, logs } = ready({ endpoint: "p2p://me:5271", label: "mine" });
      expect(await register(ctx)).to.equal(0);
      expect(sn.submitted).to.have.length(1);
      const input: any = Object.values(sn.submitted[0].$tx.$i)[0];
      expect(input.endpoints).to.deep.equal([{ transport: "p2p", host: "me", port: 5271 }]);
      expect(input.label).to.equal("mine");
      expect(logs[0]).to.match(/^registered /);
    });

    it("is idempotent: a registered key reports it, exits 0 and submits nothing", async () => {
      const { ctx, sn, logs } = ready({ endpoint: "p2p://me:5271" }, { registered: true });
      expect(await register(ctx)).to.equal(0);
      expect(sn.submitted).to.have.length(0);
      expect(logs[0]).to.match(/already registered/);
    });

    it("treats a collision answer as already registered", async () => {
      const { ctx } = ready({ endpoint: "p2p://me:5271" }, { answer: { $summary: { errors: ["1530 collision"] } } });
      expect(await register(ctx)).to.equal(0);
    });

    it("fails clearly with no endpoint, a retired key, or a rejected registration", async () => {
      const noEndpoint = ready();
      expect(await register(noEndpoint.ctx)).to.equal(1);
      expect(noEndpoint.errors.join()).to.match(/--endpoint/);
      const retired = ready({ endpoint: "p2p://me:5271" }, { registered: true, retired: true });
      expect(await register(retired.ctx)).to.equal(1);
      const rejected = ready({ endpoint: "p2p://me:5271" }, { answer: { $summary: { errors: ["Invalid public key"] } } });
      expect(await register(rejected.ctx)).to.equal(1);
      expect(rejected.errors.join()).to.contain("Invalid public key");
    });

    it("update needs a registered key and an endpoint", async () => {
      const unregistered = ready({ endpoint: "p2p://me:5271" });
      expect(await update(unregistered.ctx)).to.equal(2);
      const ok = ready({ endpoint: "p2p://new:5271" }, { registered: true });
      expect(await update(ok.ctx)).to.equal(0);
      expect(ok.sn.submitted).to.have.length(1);
      expect(await update(ready({}, { registered: true }).ctx)).to.equal(1);
    });

    it("retire asks for --yes, then retires once", async () => {
      const noYes = ready({}, { registered: true });
      expect(await retire(noYes.ctx)).to.equal(1);
      expect(noYes.sn.submitted).to.have.length(0);
      const yes = ready({ yes: true }, { registered: true });
      expect(await retire(yes.ctx)).to.equal(0);
      expect(yes.sn.submitted).to.have.length(1);
      const already = ready({ yes: true }, { registered: true, retired: true });
      expect(await retire(already.ctx)).to.equal(0);
      expect(already.sn.submitted).to.have.length(0);
      expect(await retire(ready({ yes: true }).ctx)).to.equal(2);
    });

    it("reports a missing upstream or an unreachable supernode as a failure", async () => {
      const dir = temp();
      init(make(dir).ctx);
      const none = make(dir, { endpoint: "p2p://me:1" });
      expect(await register(none.ctx)).to.equal(1);
      expect(none.errors.join()).to.match(/no upstream/);
    });
  });

  it("peers lists what the supernode knows", async () => {
    const dir = temp();
    init(make(dir, { upstream: "s.example:5260" }).ctx);
    const { ctx, logs } = make(dir, {}, () => fakeSupernode());
    expect(await peers(ctx)).to.equal(0);
    expect(logs[0]).to.contain("h1").and.contain("p2p://x:1");
  });
});
