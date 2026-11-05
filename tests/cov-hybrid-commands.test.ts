import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { init, register, retire, update, CommandContext } from "../packages/hybrid/src/commands";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";

describe("activehybrid commands, upstream failures (cov)", () => {
  let dir: string;
  const make = (flags: Record<string, any>, upstream: any) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const ctx: CommandContext = {
      flags: { config: path.join(dir, "hybrid.json"), identity: path.join(dir, ".identity"), ...flags },
      out: { log: (t) => logs.push(t), error: (t) => errors.push(t) },
      upstream: () => upstream,
    };
    return { ctx, logs, errors };
  };
  const registered = (over: any = {}) => {
    const submitted: any[] = [];
    return {
      id: "fake",
      submitted,
      streams: async (reqs: any[]) => ({ docs: [{ _id: reqs[0].id, retired: false, endpoints: [] }], missing: [] }),
      submit: async (tx: any) => (submitted.push(tx), { $summary: { commit: 1 } }),
      ...over,
    };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-cmd-cov-"));
    expect(init({ flags: { config: path.join(dir, "hybrid.json"), identity: path.join(dir, ".identity"), upstream: ["a.example:5260"] }, out: { log() {}, error() {} } })).to.equal(0);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const down = new UpstreamError("connection refused by host", "network");

  it("register reports an upstream that cannot be reached, and submits nothing", async () => {
    const up = registered({ streams: async () => { throw down; } });
    const { ctx, errors } = make({ endpoint: "p2p://h.example:5271" }, up);
    expect(await register(ctx)).to.equal(1);
    expect(errors.join()).to.contain("connection refused by host");
    expect(up.submitted).to.deep.equal([]);
  });
  it("update reports an upstream that cannot be reached", async () => {
    const up = registered({ streams: async () => { throw down; } });
    const { ctx, errors } = make({ endpoint: "p2p://h.example:5271" }, up);
    expect(await update(ctx)).to.equal(1);
    expect(errors.join()).to.contain("connection refused by host");
  });
  it("update reports a submission that throws", async () => {
    const up = registered({ submit: async () => { throw new Error("submit blew up"); } });
    const { ctx, errors, logs } = make({ endpoint: "p2p://h.example:5271" }, up);
    expect(await update(ctx)).to.equal(1);
    expect(errors.join()).to.contain("submit blew up");
    expect(logs.join()).to.not.contain("updated");
  });
  it("retire reports a submission that throws", async () => {
    const up = registered({ submit: async () => { throw new Error("retire blew up"); } });
    const { ctx, errors, logs } = make({ yes: true }, up);
    expect(await retire(ctx)).to.equal(1);
    expect(errors.join()).to.contain("retire blew up");
    expect(logs.join()).to.not.contain("retired");
  });
  it("retire reports an upstream that cannot be reached", async () => {
    const up = registered({ streams: async () => { throw down; } });
    const { ctx, errors } = make({ yes: true }, up);
    expect(await retire(ctx)).to.equal(1);
    expect(errors.join()).to.contain("connection refused by host");
    expect(up.submitted).to.deep.equal([]);
  });
});
