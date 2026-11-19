import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { ActiveRequest, ContractScope, StorageAccessError } from "@activeledger/activeutilities";
import { runSandboxed, runUnsandboxed } from "../packages/protocol/src/protocol/sandbox";

// A contract's HTTP toolkit is ActiveRequest, the same client the engine uses
// for storage, and the storage has no login. While a contract runs, a request
// to the storage's port - by any host name, any method, any module - is refused
// and never reaches the server. Everything else is left alone.
describe("Contracts cannot reach the node's storage (Activeprotocol)", () => {
  let storage: http.Server, other: http.Server;
  let storagePort = 0, otherPort = 0;
  const hits = { storage: 0, other: 0 };

  before(async () => {
    const make = (key: "storage" | "other") =>
      http.createServer((_q, s) => { hits[key]++; s.setHeader("content-type", "application/json"); s.end('{"ok":true}'); });
    storage = make("storage");
    other = make("other");
    await Promise.all([storage, other].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
    storagePort = (storage.address() as net.AddressInfo).port;
    otherPort = (other.address() as net.AddressInfo).port;
    ContractScope.protectPorts([storagePort]);
  });
  after(() => { storage.close(); other.close(); });
  beforeEach(() => { hits.storage = 0; hits.other = 0; });

  const inContract = <T>(fn: () => T, blocked: string[] = []) =>
    runSandboxed({ mode: "storage", onBlocked: (what) => blocked.push(what) }, fn);

  const refused = async (fn: () => unknown) => {
    try { await fn(); } catch (e: any) { return e; }
    throw new Error("expected the call to be refused");
  };

  it("refuses ActiveRequest to the storage port, whatever the host or method", async () => {
    const blocked: string[] = [];
    for (const host of ["127.0.0.1", "localhost"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const e = await refused(() => inContract(() => ActiveRequest.send(`http://${host}:${storagePort}/activeledger/x:volatile`, method, undefined, { a: 1 }), blocked));
        expect(e).to.be.instanceOf(StorageAccessError);
      }
    }
    expect(hits.storage).to.equal(0);
    expect(blocked).to.have.length(8);
  });

  it("refuses the node modules and fetch aimed at the storage port", async () => {
    await refused(() => inContract(() => http.get(`http://127.0.0.1:${storagePort}/`)));
    await refused(() => inContract(() => http.request({ host: "127.0.0.1", port: storagePort, path: "/", method: "PUT" })));
    await refused(() => inContract(() => net.connect(storagePort, "127.0.0.1")));
    await refused(() => inContract(() => net.connect({ port: storagePort })));
    await refused(() => inContract(() => (globalThis as any).fetch(`http://127.0.0.1:${storagePort}/`)));
    await new Promise((r) => setTimeout(r, 50));
    expect(hits.storage).to.equal(0);
  });

  it("refuses any unix socket, which is where the node's storage socket lives", async () => {
    const e = await refused(() => inContract(() => net.connect(path.join(os.tmpdir(), "anything.sock"))));
    expect(e).to.be.instanceOf(StorageAccessError);
    await refused(() => inContract(() => http.request({ socketPath: "/var/run/anything.sock", path: "/" })));
  });

  it("still blocks after the contract awaits or sets a timer", async () => {
    await refused(() => inContract(async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      return ActiveRequest.send(`http://127.0.0.1:${storagePort}/`, "GET");
    }));
    expect(hits.storage).to.equal(0);
  });

  it("leaves other destinations alone", async () => {
    const r: any = await inContract(() => ActiveRequest.send(`http://127.0.0.1:${otherPort}/`, "GET"));
    expect(r.data).to.deep.equal({ ok: true });
    await new Promise<void>((resolve, reject) => inContract(() => http.get(`http://127.0.0.1:${otherPort}/`, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject)));
    expect(hits.other).to.equal(2);
  });

  it("lets the engine through: outside a contract, and in host work a contract triggers", async () => {
    expect(((await ActiveRequest.send(`http://127.0.0.1:${storagePort}/`, "GET")) as any).data).to.deep.equal({ ok: true });
    const r: any = await inContract(() => runUnsandboxed(() => ActiveRequest.send(`http://127.0.0.1:${storagePort}/`, "GET")));
    expect(r.data).to.deep.equal({ ok: true });
    expect(hits.storage).to.equal(2);
  });

  it("cannot be told to skip its own check by an extra argument, or fooled by a body that changes when asked again", async () => {
    // The toolkit's HTTP is ActiveRequest with whatever arguments the contract passes
    const send: any = ActiveRequest.send;
    for (const extra of [[true], [300, true], [false, 300, true, true]]) {
      expect(await refused(() => inContract(() => send.call(ActiveRequest, `http://127.0.0.1:${storagePort}/activeledger/x`, "GET", undefined, undefined, ...extra)))).to.be.instanceOf(StorageAccessError);
    }
    // A body that says one thing the first time it is serialised and another the second
    let asked = 0;
    const sneaky = { toJSON: () => (++asked === 1 ? { note: "VOLATILE" } : { note: "fine" }) };
    const allowing = [`127.0.0.1:${storagePort}`];
    expect(await refused(() => runSandboxed({ mode: "storage", onBlocked: () => undefined, customDatabases: true, allow: (d) => ContractScope.listed(allowing, d) }, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}/activeledger_wallets/_bulk_docs`, "POST", undefined, sneaky as any)))).to.be.instanceOf(StorageAccessError);
    expect(hits.storage).to.equal(0);
  });

  it("keeps the older all-network block for a hybrid execution", async () => {
    const e = await refused(() => runSandboxed({ onBlocked: () => undefined }, () => http.get(`http://127.0.0.1:${otherPort}/`)));
    expect(e.name).to.equal("SupernodeOnly");
  });

  describe("an allowlist for a namespace", () => {
    const inContractAllowing = <T>(entries: string[], fn: () => T) =>
      runSandboxed({ mode: "storage", onBlocked: () => undefined, allow: (d) => ContractScope.listed(entries, d) }, fn);
    const get = (host: string, p: string) => inContractAllowing([`127.0.0.1:${storagePort}/activeledger_wallets`], () => ActiveRequest.send(`http://${host}:${storagePort}${p}`, "GET"));

    it("lets a listed database through, under any name for the same machine", async () => {
      const r: any = await get("127.0.0.1", "/activeledger_wallets/abc");
      expect(r.data).to.deep.equal({ ok: true });
      // "localhost" is the same machine to the list; where it resolves is not the guard's concern
      await get("localhost", "/activeledger_wallets/abc");
      expect(hits.storage).to.be.at.least(1);
    });

    it("refuses every other database on the same port", async () => {
      for (const p of ["/activeledger", "/activeledger_wallets_old", "/activeledger_deposits/x", "/"]) {
        expect(await refused(() => get("127.0.0.1", p)), p).to.be.instanceOf(StorageAccessError);
      }
      expect(hits.storage).to.equal(0);
    });

    it("cannot climb out of a listed path", async () => {
      for (const p of ["/activeledger_wallets/../activeledger", "/activeledger_wallets/%2e%2e/activeledger", "/activeledger_wallets/./../activeledger/x:volatile"]) {
        expect(await refused(() => get("127.0.0.1", p)), p).to.be.instanceOf(StorageAccessError);
      }
      expect(hits.storage).to.equal(0);
    });

    it("lets an entry with no path through for any path, and the node modules too", async () => {
      const whole = [`127.0.0.1:${storagePort}`];
      const r: any = await inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}/activeledger_other/x`, "PUT", undefined, { a: 1 }));
      expect(r.data).to.deep.equal({ ok: true });
      await new Promise<void>((resolve, reject) => inContractAllowing(whole, () => http.get(`http://localhost:${storagePort}/z`, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject)));
      expect(hits.storage).to.equal(2);
    });

    it("never lets a bare socket to the storage through, listed or not, since it could ask for anything", async () => {
      await refused(() => inContractAllowing([`127.0.0.1:${storagePort}/activeledger_wallets`], () => net.connect(storagePort, "127.0.0.1")));
      await refused(() => inContractAllowing([`127.0.0.1:${storagePort}`], () => net.connect(storagePort, "127.0.0.1")));
    });

    it("never lets anything through that names :volatile, in any database, or touches the node's own databases", async () => {
      ContractScope.neverDatabases(["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror", "activeledgererrors_archive"]);
      const whole = [`127.0.0.1:${storagePort}`];
      for (const p of [
        "/activeledger_wallets/x:volatile", "/activeledger_wallets/x%3Avolatile", "/activeledger_wallets/x%3AVOLATILE",
        "/activeledger/x", "/ACTIVELEDGER/x", "//activeledger/x", "/activeledgerevents/_all_docs", "/activeledgererrors/x", "/activeledger%5F/x".replace("%5F", ""),
      ]) {
        const e = await refused(() => inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}${p}`, "GET")));
        expect(e, p).to.be.instanceOf(StorageAccessError);
      }
      expect(hits.storage).to.equal(0);
      // The word itself, however it is written, in the path or the query
      for (const p of [
        "/activeledger_wallets/volatile", "/activeledger_wallets/VoLaTiLe", "/activeledger_wallets/%76olatile",
        "/activeledger_wallets/%2576olatile", "/activeledger_wallets/%25252576olatile", "/activeledger_wallets/x?key=%22volatile%22",
        "/activeledger_wallets/x?%76%6f%6c%61%74%69%6c%65=1", "/activeledger_wallets/x%5Cu0076olatile",
      ]) {
        expect(await refused(() => inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}${p}`, "GET"))), p).to.be.instanceOf(StorageAccessError);
      }
      // ... and in a body, as an object, a string or an escaped string
      for (const body of [{ docs: [{ _id: "k:volatile" }] }, { VOLATILE: 1 }, '{"_id":"k:\\u0076olatile"}', "k%3Avolatile"]) {
        expect(await refused(() => inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}/activeledger_wallets/_bulk_docs`, "POST", undefined, body as any))), JSON.stringify(body)).to.be.instanceOf(StorageAccessError);
      }
      // The node's error database and its archive too
      for (const p of ["/activeledgererrors/x", "/activeledgererror/x", "/activeledgererrors_archive/x"]) {
        expect(await refused(() => inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}${p}`, "GET"))), p).to.be.instanceOf(StorageAccessError);
      }
      expect(hits.storage).to.equal(0);
      ContractScope.neverDatabases(["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror", "activeledgererrors_archive"]);
      // Another database is still reachable on that whole-port entry
      const ok: any = await inContractAllowing(whole, () => ActiveRequest.send(`http://127.0.0.1:${storagePort}/activeledger_wallets/x`, "GET"));
      expect(ok.data).to.deep.equal({ ok: true });
    });

    it("allows POST only where the body can be read", async () => {
      const whole = [`127.0.0.1:${storagePort}`];
      const url = `http://127.0.0.1:${storagePort}/activeledger_wallets/_bulk_docs`;
      // ActiveRequest shows its body to the check: a clean one goes through, one that says volatile does not
      const ok: any = await inContractAllowing(whole, () => ActiveRequest.send(url, "POST", undefined, { docs: [{ _id: "w1", balance: 1 }], options: {} }));
      expect(ok.data).to.deep.equal({ ok: true });
      expect(await refused(() => inContractAllowing(whole, () => ActiveRequest.send(url, "POST", undefined, { docs: [{ _id: "w1", note: "Volatile" }] })))).to.be.instanceOf(StorageAccessError);
      // A raw request is written to after it is made, so its body cannot be read: refused for any method that carries one
      for (const method of ["POST", "PUT", "PATCH"]) {
        await refused(() => inContractAllowing(whole, () => http.request(url, { method })));
      }
      // fetch: a string body is read; anything else cannot be
      await refused(() => inContractAllowing(whole, () => (globalThis as any).fetch(url, { method: "POST", body: '{"a":"%76olatile"}' })));
      await refused(() => inContractAllowing(whole, () => (globalThis as any).fetch(url, { method: "POST", body: new Uint8Array([1, 2, 3]) })));
      // Reads and deletes carry no body: allowed on a listed database
      await new Promise<void>((resolve, reject) => inContractAllowing(whole, () => http.get(`http://127.0.0.1:${storagePort}/activeledger_wallets/x`, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject)));
    });

    it("does not let a listed entry cover another port", async () => {
      expect(ContractScope.listed([`127.0.0.1:1/x`], { host: "127.0.0.1", port: 2, path: "/x" })).to.equal(false);
      expect(ContractScope.listed([`10.0.0.5:${storagePort}`], { host: "127.0.0.1", port: storagePort, path: "/" })).to.equal(false);
    });

    it("reads a request path the way the storage does", () => {
      const entry = ["127.0.0.1:5259/activeledger_wallets"];
      const on = (path: string) => ContractScope.listed(entry, { host: "127.0.0.1", port: 5259, path });
      // Same database, written differently: allowed, because the storage reads them as it
      expect(on("/activeledger%5Fwallets/x")).to.equal(true);
      expect(on("//activeledger_wallets//x")).to.equal(true);
      expect(on("/activeledger_wallets/")).to.equal(true);
      expect(on("/activeledger_wallets?x=1")).to.equal(true);
      // Another database, or no database: refused
      expect(on("/activeledger%2Fwallets")).to.equal(false);
      expect(on("/activeledger_wallets%2f..%2factiveledger")).to.equal(false);
      expect(on("/activeledger_wallets%252e%252e/activeledger")).to.equal(false);
      expect(on("/Activeledger_Wallets")).to.equal(false);
      expect(on("/activeledger")).to.equal(false);
      expect(on("/")).to.equal(false);
      expect(on("/_all_dbs")).to.equal(false);
    });

    it("understands ::1 and an unlisted port", () => {
      expect(ContractScope.listed(["[::1]:5259/a"], { host: "localhost", port: 5259, path: "/a/b" })).to.equal(true);
      expect(ContractScope.listed(["localhost:8080"], { host: "127.0.0.1", port: 8080, path: "/ethereum/nonce/" })).to.equal(true);
      expect(ContractScope.listed(["localhost:8080"], { host: "127.0.0.1", port: 5259, path: "/" })).to.equal(false);
    });
  });
});
