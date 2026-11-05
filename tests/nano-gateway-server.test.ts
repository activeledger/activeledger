import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveHttpd } from "@activeledger/httpd";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { NanoGatewayServer } from "../packages/nano-gateway/src/server";

describe("nano-gateway server wiring", () => {
  const proto: any = ActiveHttpd.prototype;
  const dsProto: any = ActiveDSConnect.prototype;
  const saved: any = {};
  let routes: { url: string; method: string; handler: Function }[];
  let listened: any[];
  let infos: string[];
  let dir: string;
  let dsCalls: any[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanogw-srv-"));
    routes = [];
    listened = [];
    infos = [];
    dsCalls = [];
    for (const [o, n] of [[proto, "use"], [proto, "listen"], [dsProto, "get"], [dsProto, "allDocs"], [(ActiveLogger as any), "info"]] as any) {
      saved[n] = saved[n] ?? o[n];
    }
    proto.use = function (url: string, method: string, handler: Function) { routes.push({ url, method, handler }); };
    proto.listen = function (...a: any[]) { listened.push(a); };
    dsProto.get = async function (id: string) { dsCalls.push(["get", (this as any).location, id]); return { _id: id, umid: "U" }; };
    dsProto.allDocs = async function (a: any) { dsCalls.push(["allDocs", a]); return { rows: [{ doc: { _id: "z" } }] }; };
    (ActiveLogger as any).info = (m: string) => infos.push(m);
    ActiveOptions.set("db", { url: "http://h:1", database: "ledger" });
    ActiveOptions.set("nanoGateway", { allowlist: path.join(dir, "al.json"), authWindowSeconds: 60, heartbeatSeconds: 5 });
    ActiveOptions.set("host", undefined);
  });
  afterEach(() => {
    proto.use = saved.use;
    proto.listen = saved.listen;
    dsProto.get = saved.get;
    dsProto.allDocs = saved.allDocs;
    (ActiveLogger as any).info = saved.info;
    ActiveOptions.set("db", undefined);
    ActiveOptions.set("nanoGateway", undefined);
    ActiveOptions.set("host", undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const find = (url: string) => routes.find((r) => r.url === url)!;

  it("registers the five expected routes with their methods", () => {
    new NanoGatewayServer();
    expect(routes.map((r) => `${r.method} ${r.url}`)).to.deep.equal([
      "GET /",
      "POST /api/stream",
      "GET /api/stream/*",
      "GET /api/tx/*",
      "POST /api/activity/subscribe",
    ]);
  });

  it("health route reports the approved nano count from the allowlist file", () => {
    fs.writeFileSync(path.join(dir, "al.json"), JSON.stringify([{ identity: "a" }, { identity: "b" }]));
    new NanoGatewayServer();
    expect(find("/").handler()).to.deep.equal({ status: "ok", service: "nano-gateway", approvedNanos: 2 });
  });

  it("data routes use the configured db location and pass through results", async () => {
    new NanoGatewayServer();
    expect(await find("/api/stream/*").handler({ url: ["api", "stream", "abc"] })).to.deep.equal({ stream: { _id: "abc", umid: "U" } });
    expect(await find("/api/tx/*").handler({ url: ["api", "tx", "T"] })).to.deep.equal({ transaction: "U" });
    expect(await find("/api/stream").handler({ body: ["z"] })).to.deep.equal({ streams: [{ _id: "z" }] });
    expect(dsCalls[0]).to.deep.equal(["get", "http://h:1/ledger", "abc"]);
    expect(dsCalls[1]).to.deep.equal(["get", "http://h:1/ledger", "T:umid"]);
  });

  it("subscribe route authenticates with the configured allowlist", async () => {
    new NanoGatewayServer();
    const log: string[] = [];
    const res: any = {
      cork(cb: () => void) { cb(); return res; },
      writeStatus(s: string) { log.push(s); return res; },
      writeHeader() { return res; },
      end(b: string) { log.push(b); return res; },
    };
    const out = await find("/api/activity/subscribe").handler({ body: { identity: "x", timestamp: 1, signature: "s" } }, {}, res);
    expect(out).to.equal("handled");
    expect(log[0]).to.equal("403 Forbidden");
    expect(log[1]).to.contain("not on the allowlist");
  });

  it("falls back to default gateway config when none is set", () => {
    ActiveOptions.set("nanoGateway", undefined);
    const s = new NanoGatewayServer();
    expect(find("/").handler().approvedNanos).to.be.a("number");
    expect(s).to.be.instanceOf(NanoGatewayServer);
  });

  it("start listens on the configured port with the log flag and announces it", () => {
    ActiveOptions.set("host", "0.0.0.0:6123");
    new NanoGatewayServer().start(true);
    expect(listened).to.deep.equal([[6123, true]]);
    expect(infos[0]).to.equal("nano-gateway listening on 0.0.0.0:6123 (0 approved nanos)");
  });

  it("start defaults to port 5270 and logs off", () => {
    new NanoGatewayServer().start();
    expect(listened).to.deep.equal([[5270, false]]);
  });
});
