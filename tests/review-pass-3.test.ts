import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import * as vmModule from "vm";
import { ActiveRequest, ContractScope } from "@activeledger/activeutilities";
import { ActiveOptions } from "@activeledger/activeoptions";
import { runSandboxed } from "../packages/protocol/src/protocol/sandbox";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import Contract from "../packages/activeledger/src/contracts/default/contract";

// Review pass 3. Every assertion states the CORRECT behaviour; a failing assertion is a finding.
// Part A: regressions for legitimate contracts (scopedContract facade, emitter facade, sandbox
// normalise/plainThrown, deploy scan rule 7). Part B: the new storage-guard surface (held).

const UMID = "umid-rp3";
const NEVER = ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror", "activeledgererrors_archive", "activeledgererror_archive"];
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function scan(source: string, namespace = "somenamespace"): string | null {
  try {
    (Contract.prototype as any).securityScan.call({}, source, namespace);
    return null;
  } catch (e: any) {
    return e.message;
  }
}
const wrap = (body: string) => `export default class Foo { vote() { ${body} } }`;

describe("review pass 3", function () {
  this.timeout(60000);
  const saved: any = {};
  let storage: http.Server, port = 0;
  const seen: { method: string; url: string }[] = [];
  const sockets = new Set<net.Socket>();

  before(async () => {
    storage = http.createServer((q, s) => { seen.push({ method: q.method!, url: q.url! }); s.end("{}"); });
    storage.on("connection", (c) => sockets.add(c));
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    port = (storage.address() as net.AddressInfo).port;
    ContractScope.protectPorts([port]);
    ContractScope.neverDatabases(NEVER);
    saved.build = ActiveOptions.get<number>("build", 0);
    saved.db = ActiveOptions.get<any>("db", undefined);
    saved.security = ActiveOptions.get<any>("security", undefined);
    ActiveOptions.set("build", 50600);
    ActiveOptions.set("db", { selfhost: { port }, database: "activeledger", event: "activeledgerevents", error: "activeledgererrors" });
    ActiveOptions.set("security", {});
  });
  after(() => {
    sockets.forEach((s) => s.destroy()); storage.close();
    ActiveOptions.set("build", saved.build); ActiveOptions.set("db", saved.db); ActiveOptions.set("security", saved.security);
    delete (globalThis as any)[Symbol.for("activeledger.protectedPorts")];
    delete (globalThis as any)[Symbol.for("activeledger.neverDatabases")];
  });
  beforeEach(() => { seen.length = 0; ActiveOptions.set("build", 50600); ActiveOptions.set("security", {}); });

  const mkvm = (ns = "somens", execution?: any): any => {
    const vm: any = new VirtualMachine(`localhost:${port}`, {} as any, {} as any);
    vm.contractReferences = { [UMID]: { tx: { $namespace: ns, $contract: "c@1.0.0" }, inputs: {} } };
    if (execution) vm.executions = { [UMID]: execution };
    return vm;
  };
  const forbiddenSend = () => ActiveRequest.send(`http://127.0.0.1:${port}/activeledger/zz:volatile`, "GET");

  // ---------------------------------------------------------------------------------------------
  describe("A1 deploy scan rule 7: false positives on realistic source", () => {
    const ok = (label: string, body: string) => it(`does not refuse ${label}`, () => expect(scan(wrap(body)), body).to.equal(null));
    ok("an error message with a colon before the word volatile", 'throw new Error("Error: volatile data missing");');
    ok("a log line 'Stream: volatile'", 'this.log("Stream: volatile");');
    ok("a template error message `${name}: volatile data`", "throw new Error(`${name}: volatile data is node local`);");
    ok("a message that links to public docs and mentions volatile", 'return "see https://docs.activeledger.io/guide for volatile data";');
    ok("a public repository URL", 'return "https://github.com/activeledger/activeledger";');
    ok("a public repository URL (sdk)", 'return "https://github.com/activeledger/activeledger-sdk-js";');
    ok("a public URL whose path starts with activeledger-", 'return "https://example.com/activeledger-docs/page";');
    ok("'and/or volatile' prose", 'throw new Error("use state and/or volatile");');
    ok("a string literal type such as 'state:volatile'", 'const kind: "state:volatile" | "state:stream" = "state:stream"; return kind;');
  });

  // ---------------------------------------------------------------------------------------------
  describe("A2 scopedContract facade", () => {
    it("results are copied to plain data inside a hybrid's sandbox too (its network block would not cover a toJSON run later)", () => {
      const vm = mkvm("default", { supernode: false });
      const o = { d: new Date(0) };
      expect(vm.scopedContract(UMID, { f: () => o }).f()).to.deep.equal({ d: new Date(0).toISOString() });
    });

    it("a method that returns this still returns the contract (chaining)", () => {
      const vm = mkvm();
      const c: any = { x: 1, f() { return this; }, g() { return 2; } };
      const p = vm.scopedContract(UMID, c);
      const r = p.f();
      expect(r === p || r === c, "returned a plain copy, not the contract").to.equal(true);
    });

    it("getReturnContractData does not throw for data JSON cannot hold (circular), as it did not before the facade (handleVoteError calls it)", () => {
      const vm = mkvm();
      const circular: any = { a: 1 }; circular.self = circular;
      vm.smartContracts[UMID] = vm.scopedContract(UMID, { getReturnToRemote: () => circular });
      expect(() => vm.getReturnContractData(UMID)).to.not.throw();
    });

    it("getReturnContractData does not throw for a BigInt in the data", () => {
      const vm = mkvm();
      vm.smartContracts[UMID] = vm.scopedContract(UMID, { getReturnToRemote: () => ({ amount: 10n }) });
      expect(() => vm.getReturnContractData(UMID)).to.not.throw();
    });

    it("an object whose toJSON returns undefined does not make the facade throw a SyntaxError", () => {
      const vm = mkvm();
      const p = vm.scopedContract(UMID, { f: () => ({ toJSON() { return undefined; } }) });
      expect(() => p.f()).to.not.throw();
    });

    it("a state nested 2000 levels deep can be read", () => {
      const vm = mkvm();
      const deep: any = {}; let cur = deep;
      for (let i = 0; i < 2000; i++) { cur.n = {}; cur = cur.n; }
      expect(() => vm.scopedContract(UMID, { f: () => deep }).f()).to.not.throw();
    });

    it("an Error from another realm keeps its message when thrown through the facade", () => {
      const vm = mkvm();
      const foreign = vmModule.runInNewContext("new Error('boom')");
      const p = vm.scopedContract(UMID, { f: () => { throw foreign; } });
      let caught: any;
      try { p.f(); } catch (e) { caught = e; }
      expect(caught && (caught.message ?? JSON.stringify(caught))).to.include("boom");
    });

    it("a promise REJECTED with an object does not run that object's toJSON/toString outside the sandbox when the host handles the error (handleVoteError does JSON.stringify(error))", async () => {
      const vm = mkvm();
      const evil = () => { forbiddenSend().catch(() => undefined); };
      const p = vm.scopedContract(UMID, { vote: async () => { throw { toJSON() { evil(); return {}; }, toString() { evil(); return "x"; } }; } });
      let error: any;
      try { await p.vote(); } catch (e) { error = e; }
      // what handleVoteError and the logger do, outside the sandbox
      try { JSON.stringify(error); String(error); } catch { /* shape only */ }
      await settle(300);
      expect(seen, "the contract's code reached the storage from host code").to.deep.equal([]);
    });

    it("the same for a rejection coming from a thenable whose then rejects", async () => {
      const vm = mkvm();
      const evil = () => { forbiddenSend().catch(() => undefined); };
      const p = vm.scopedContract(UMID, { vote: () => ({ then(_res: any, rej: any) { rej({ toJSON() { evil(); return {}; } }); } }) });
      let error: any;
      try { await p.vote(); } catch (e) { error = e; }
      try { JSON.stringify(error); } catch { /* shape only */ }
      await settle(300);
      expect(seen).to.deep.equal([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("A3 contractEmitter facade", () => {


    it("off() removes one registration of a listener added twice, like EventEmitter does", () => {
      const em: any = mkvm().contractEmitter();
      let n = 0;
      const l = () => { n++; };
      em.on("ev-rp3", l); em.on("ev-rp3", l);
      em.off("ev-rp3", l);
      em.emit("ev-rp3");
      expect(n, "one registration should remain").to.equal(1);
    });

    it("once + off before it fires: the listener does not run", () => {
      const em: any = mkvm().contractEmitter();
      let n = 0;
      const l = () => { n++; };
      em.once("ev-rp3b", l); em.off("ev-rp3b", l); em.emit("ev-rp3b");
      expect(n).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("A4 runSandboxed normalise / plainThrown", () => {
    const ctx = () => ({ mode: "storage" as const, onBlocked: () => undefined });
    it("a thrown non-Error object keeps its data", () => {
      let caught: any;
      try { runSandboxed(ctx(), () => { throw { code: 7, reason: "x" }; }); } catch (e) { caught = e; }
      expect(caught).to.deep.equal({ code: 7, reason: "x" });
    });
    it("an Error subclass keeps its class and fields", () => {
      class MyErr extends Error { code = 3; }
      let caught: any;
      try { runSandboxed(ctx(), () => { throw new MyErr("m"); }); } catch (e) { caught = e; }
      expect(caught).to.be.instanceOf(MyErr);
      expect(caught.code).to.equal(3);
    });
    it("a thenable is read for then once (a getter with a side effect is not run three times)", () => {
      let reads = 0;
      const o = { get then() { reads++; return undefined; } };
      runSandboxed(ctx(), () => o);
      expect(reads).to.be.at.most(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("B new surface: allowDatabases, isNamedDatabase / isCustomDatabase (these hold)", () => {
    const enforce = (scope: any, path: string, method = "GET") => {
      try { return !!ContractScope.enforce(scope, { host: "127.0.0.1", port, path, method }); } catch { return false; }
    };
    const own = ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror_archive"];
    const spell = (n: string) => [n.toUpperCase(), n + ".", n + " ", n + "%20", n + "%2e", n + "%00", n + "​", n.replace("e", "%65"), "./" + n, "x/../" + n, "%2e/" + n, n + ";x", n + "%3bx", n + "%23x", n + "%5c", n + "\t", n + "%0a", encodeURIComponent(encodeURIComponent(n)), n + "%2f", "ａｃｔｉｖｅ" + n.slice(6)];
    it("no spelling of a node database is reached under customDatabases, a list, or '*'", () => {
      const scopes = [{ customDatabases: true }, { databases: ["*"] }, { databases: own.concat("activeledger_x") }, { customDatabases: true, databases: own }];
      for (const s of scopes) for (const n of own) for (const v of spell(n)) for (const tail of ["/doc", "/_all_docs", ""]) {
        expect(enforce(s, `/${v}${tail}`), `${JSON.stringify(s)} /${v}${tail}`).to.equal(false);
      }
    });
    it("a list names databases exactly (case, trailing space, non-string entries)", () => {
      expect(enforce({ databases: ["activeledger_x"] }, "/activeledger_x/doc")).to.equal(true);
      expect(enforce({ databases: ["ACTIVELEDGER_X"] }, "/activeledger_x/doc")).to.equal(false);
      expect(enforce({ databases: ["activeledger_x "] }, "/activeledger_x/doc")).to.equal(false);
      expect(enforce({ databases: ["activeledger_y"] }, "/activeledger_x/doc")).to.equal(false);
      expect(enforce({ databases: [5, null, {}] as any }, "/activeledger_x/doc")).to.equal(false);
    });
    it("isNamedDatabase does not treat a string as a list (substring match)", () => {
      expect(ContractScope.isNamedDatabase("/activeledger_x/doc", "activeledger_xyz" as any)).to.equal(false);
    });
  });

  describe("B Socket.prototype.connect catch-all and net's normalised arguments", () => {
    // net.connect, net.createConnection and anything that calls socket.connect(net._normalizeArgs(...))
    // hand Socket.prototype.connect ONE argument: the array [options, cb]. connectDestination reads
    // .host / .port off the array, finds nothing, and the guard checks nothing.
    const attempt = async (ctxExtra: any, targetPort: number, serverGot: string[]) => {
      let outcome = "none";
      await runSandboxed({ mode: "storage", onBlocked: () => undefined, ...ctxExtra }, async () => {
        const nodeNet = require("net") as any;
        try {
          const s = new nodeNet.Socket().connect(nodeNet._normalizeArgs([targetPort, "127.0.0.1"]));
          s.on("error", () => undefined);
          s.write("GET /activeledger/zz:volatile HTTP/1.1\r\nHost: x\r\n\r\n");
          outcome = "opened";
        } catch (e: any) { outcome = e.name; }
      });
      await settle(300);
      return outcome;
    };
    it("a bare socket to the storage port cannot be opened by passing net's normalised arguments", async () => {
      const got: string[] = [];
      const srv = net.createServer((c) => { sockets.add(c); c.on("data", (d) => got.push(d.toString())); c.on("error", () => undefined); });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as net.AddressInfo).port;
      ContractScope.protectPorts([p]);
      const outcome = await attempt({}, p, got);
      sockets.forEach((s) => s.destroy()); srv.close();
      expect({ outcome, received: got.join("").split("\r\n")[0] }).to.deep.equal({ outcome: "StorageAccessError", received: "" });
    });
    it("this machine's other ports stay closed to a contract without allowLocalhost when the same route is used", async () => {
      const got: string[] = [];
      const srv = net.createServer((c) => { sockets.add(c); c.on("data", (d) => got.push(d.toString())); c.on("error", () => undefined); });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as net.AddressInfo).port;
      const outcome = await attempt({ denyLocalhost: true }, p, got);
      sockets.forEach((s) => s.destroy()); srv.close();
      expect({ outcome, received: got.join("").length > 0 }).to.deep.equal({ outcome: "StorageAccessError", received: false });
    });
  });

  describe("B the peek flag: one approval, one connection", () => {
    it("an approved request's approval opens exactly one real connection through net.connect", async () => {
      let accepted = 0;
      const srv = net.createServer((c) => { accepted++; c.on("error", () => undefined); });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as net.AddressInfo).port;
      ContractScope.protectPorts([p]);
      const results: string[] = [];
      await runSandboxed({ mode: "storage", customDatabases: true, onBlocked: () => undefined }, async () => {
        const scope = ContractScope.current()!;
        const run = ContractScope.enforce(scope, { host: "127.0.0.1", port: p, path: "/activeledger_x/doc", method: "GET" })!;
        run(() => {
          for (let i = 0; i < 3; i++) {
            try { (require("net") as typeof net).connect(p, "127.0.0.1").on("error", () => undefined).destroy(); results.push("opened"); } catch (e: any) { results.push(e.name); }
          }
        });
      });
      await settle(100);
      srv.close();
      expect(results.filter((r) => r === "opened"), JSON.stringify(results)).to.have.length(1);
    });
  });
});
