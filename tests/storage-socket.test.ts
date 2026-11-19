import { ActiveHttpd } from "../packages/httpd/src/httpd";
import { StorageSocket, ActiveRequest } from "../packages/utilities/src/index";
// ActiveDSConnect registers on the built package's copy of the class
import { StorageSocket as Built } from "@activeledger/activeutilities";
import { ActiveDSConnect } from "../packages/options/src/dsconnect";
import { ActiveOptions } from "../packages/options/src/options";
import { serveStorageSocket } from "../packages/storage/src/storagesocket";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The storage socket: the same routes as HTTP over a local framed
 * connection, with HTTP as the fallback when it is not there.
 */
describe("Storage socket", () => {
  const routes = () => {
    const app = new ActiveHttpd();
    app.use("echo", "POST", async (incoming: any) => ({ got: incoming.body, q: incoming.query }));
    app.use("*/doc", "GET", async (incoming: any) => ({ db: incoming.url[0] }));
    app.use("boom", "GET", async () => { const e: any = new Error("x"); e.status = 418; throw e; });
    app.use("feed", "GET", async (_i: any, _r: any, res: any) => { res.write("x"); return "handled"; });
    return app;
  };

  describe("invoke()", () => {
    it("runs a route with a JSON body and query like the server would", async () => {
      const r = await routes().invoke("POST", "/echo?a=1", Buffer.from('{"n":2}'));
      expect(r.status).to.equal(200);
      expect(JSON.parse(r.body)).to.deep.equal({ got: { n: 2 }, q: { a: "1" } });
    });
    it("answers 404 for no route, 400 for a bad body, the error's status when a route throws", async () => {
      const app = routes();
      expect((await app.invoke("GET", "/nothing/here/at/all")).status).to.equal(404);
      expect((await app.invoke("POST", "/echo", Buffer.from("{nope"))).status).to.equal(400);
      expect((await app.invoke("GET", "/boom")).status).to.equal(418);
    });
    it("refuses a route that writes to the connection itself", async () => {
      expect((await routes().invoke("GET", "/feed")).status).to.equal(501);
    });
  });

  describe("over the socket", () => {
    let dir: string, sock: string, server: net.Server;
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssock-"));
      sock = path.join(dir, "s.sock");
      server = serveStorageSocket(routes(), sock);
      await new Promise((r) => server.once("listening", r));
    });
    afterEach(() => {
      StorageSocket.unregisterAll();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("answers requests through ActiveRequest.send, many at once", async () => {
      StorageSocket.register("http://127.0.0.1:59871", sock);
      const all = await Promise.all(
        Array.from({ length: 50 }, (_, i) => ActiveRequest.send("http://127.0.0.1:59871/echo?i=" + i, "POST", undefined, { n: i }))
      );
      all.forEach((r: any, i) => expect(r.data).to.deep.equal({ got: { n: i }, q: { i: String(i) } }));
    });

    it("reports a missing route as no data, like a failed HTTP request", async () => {
      StorageSocket.register("http://127.0.0.1:59871", sock);
      expect((await ActiveRequest.send("http://127.0.0.1:59871/missing/x/y/z", "GET")).data).to.equal(null);
    });

    it("falls back to HTTP when nothing is listening on the socket", async () => {
      const web = http.createServer((_q, s) => s.end('{"via":"http"}'));
      await new Promise<void>((r) => web.listen(59872, "127.0.0.1", r));
      try {
        StorageSocket.register("http://127.0.0.1:59872", path.join(dir, "absent.sock"));
        expect((await ActiveRequest.send("http://127.0.0.1:59872/x", "GET")).data).to.deep.equal({ via: "http" });
      } finally {
        web.close();
      }
    });

    it("keeps feeds and custom headers on HTTP", async () => {
      const seen: string[] = [];
      const web = http.createServer((q, s) => { seen.push(q.url || ""); s.end('{"via":"http"}'); });
      await new Promise<void>((r) => web.listen(59873, "127.0.0.1", r));
      try {
        StorageSocket.register("http://127.0.0.1:59873", sock);
        await ActiveRequest.send("http://127.0.0.1:59873/db/events?x=1", "GET");
        await ActiveRequest.send("http://127.0.0.1:59873/echo", "POST", ["X-Bundle:1"], { a: 1 });
        expect(seen).to.deep.equal(["/db/events?x=1", "/echo"]);
      } finally {
        web.close();
      }
    });

    it("does not connect to a socket in a folder others can write to, or one that is not a socket", async () => {
      const web = http.createServer((_q, s) => s.end('{"via":"http"}'));
      await new Promise<void>((r) => web.listen(59875, "127.0.0.1", r));
      try {
        const open = fs.mkdtempSync(path.join(os.tmpdir(), "ssock-open-"));
        fs.chmodSync(open, 0o777);
        const loose = path.join(open, "s.sock");
        const srv = net.createServer((s) => s.end());
        await new Promise<void>((r) => srv.listen(loose, r));
        StorageSocket.register("http://127.0.0.1:59875", loose);
        expect(StorageSocket.trusted(loose)).to.equal(false);
        expect((await ActiveRequest.send("http://127.0.0.1:59875/x", "GET")).data).to.deep.equal({ via: "http" });
        srv.close();
        fs.rmSync(open, { recursive: true, force: true });
        const plain = path.join(dir, "plain.sock");
        fs.writeFileSync(plain, "");
        expect(StorageSocket.trusted(plain)).to.equal(false);
      } finally {
        web.close();
      }
    });

    it("the server will not bind in a folder that is not private to this user", () => {
      const open = fs.mkdtempSync(path.join(os.tmpdir(), "ssock-open-"));
      fs.chmodSync(open, 0o777);
      const target = path.join(open, "s.sock");
      const srv = serveStorageSocket(routes(), target);
      expect(srv.listening).to.equal(false);
      expect(fs.existsSync(target)).to.equal(false);
      fs.rmSync(open, { recursive: true, force: true });
    });

    it("fails, and does not replay, a request in flight when the connection drops", async () => {
      const dead = path.join(dir, "dead.sock");
      const silent = net.createServer((s) => s.once("data", () => s.destroy()));
      await new Promise<void>((r) => silent.listen(dead, r));
      try {
        StorageSocket.register("http://127.0.0.1:59874", dead);
        expect((await ActiveRequest.send("http://127.0.0.1:59874/echo", "POST", undefined, { a: 1 })).data).to.equal(null);
      } finally {
        silent.close();
      }
    });
  });

  describe("switch", () => {
    afterEach(() => {
      Built.unregisterAll();
      ActiveOptions.set("db", undefined);
    });
    it("is used by default for the node's own storage port, and not when db.selfhost.socket is false", () => {
      ActiveOptions.set("db", { selfhost: { port: "5979" } });
      new ActiveDSConnect("http://127.0.0.1:5979/activeledger");
      expect(Built.for("http://127.0.0.1:5979")).to.not.equal(undefined);
      Built.unregisterAll();
      ActiveOptions.set("db", { selfhost: { port: "5979", socket: false } });
      new ActiveDSConnect("http://127.0.0.1:5979/activeledger");
      expect(Built.for("http://127.0.0.1:5979")).to.equal(undefined);
    });
    it("is not used for another host or port", () => {
      ActiveOptions.set("db", { selfhost: { port: "5979" } });
      new ActiveDSConnect("http://10.0.0.5:5979/activeledger");
      new ActiveDSConnect("http://127.0.0.1:5980/activeledger");
      expect(Built.for("http://10.0.0.5:5979")).to.equal(undefined);
      expect(Built.for("http://127.0.0.1:5980")).to.equal(undefined);
    });
  });
});
