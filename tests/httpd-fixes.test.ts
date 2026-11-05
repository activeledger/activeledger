import { expect } from "chai";
import "mocha";
import * as http from "http";
import { us_socket_local_port } from "uWebSockets.js";
import { ActiveHttpd } from "../packages/httpd/src/httpd";

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

// Rejects after `timeout` ms if the server never finishes the response.
function request(
  port: number, method: string, path: string, body?: string, timeout = 1500
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("response never finished")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("ActiveHttpd fixes", () => {
  let httpd: ActiveHttpd;
  let port: number;

  before(async () => {
    httpd = new ActiveHttpd();
    httpd.use("/none", "GET", async () => undefined);
    httpd.use("/any", "ALL", async (i: any, r: any) => ({ route: "any-all", method: r.method }));
    httpd.use("/mixed", "ALL", async () => ({ route: "mixed-all" }));
    httpd.use("/mixed", "GET", async () => ({ route: "mixed-get" }));
    httpd.use("/mixed2", "GET", async () => ({ route: "mixed2-get" }));
    httpd.use("/mixed2", "ALL", async () => ({ route: "mixed2-all" }));
    httpd.use("/echo", "POST", async (incoming: any) => ({ got: incoming.body }));
    httpd.use("/echo", "PUT", async (incoming: any) => ({ put: incoming.body }));
    httpd.listen(0);
    await new Promise((r) => setTimeout(r, 200));
    port = us_socket_local_port((httpd as any).listenSocket);
  });
  after(() => httpd.shutdown(false));

  describe("empty responses are finished", () => {
    it("unknown route answers 404 and completes", async () => {
      const r = await request(port, "GET", "/nothing");
      expect(r.status).to.equal(404);
      expect(r.body).to.equal("");
      expect(r.headers["access-control-allow-origin"]).to.equal("*");
    });

    it("handler returning nothing answers 404 and completes", async () => {
      expect((await request(port, "GET", "/none")).status).to.equal(404);
    });
  });

  describe("POST and PUT body parsing", () => {
    it("an empty POST or PUT body is an empty object", async () => {
      const a = await request(port, "POST", "/echo");
      expect(a.status).to.equal(200);
      expect(JSON.parse(a.body)).to.deep.equal({ got: {} });
      const b = await request(port, "PUT", "/echo");
      expect(JSON.parse(b.body)).to.deep.equal({ put: {} });
    });

    it("a valid JSON body still parses", async () => {
      const r = await request(port, "POST", "/echo", JSON.stringify({ a: 1 }));
      expect(JSON.parse(r.body)).to.deep.equal({ got: { a: 1 } });
    });

    it("a non-empty body that is not JSON is a 400 with a JSON error, and the server stays up", async () => {
      for (const method of ["POST", "PUT"]) {
        const r = await request(port, method, "/echo", "{not json");
        expect(r.status, method).to.equal(400);
        expect(r.headers["content-type"]).to.equal("application/json");
        expect(JSON.parse(r.body).error).to.be.a("string");
      }
      expect((await request(port, "POST", "/echo", "{}")).status).to.equal(200);
    });
  });

  describe("ALL routes", () => {
    it("answer every method", async () => {
      for (const method of ["GET", "POST", "PUT"]) {
        const r = await request(port, method, "/any", method === "GET" ? undefined : "{}");
        expect(r.status, method).to.equal(200);
        expect(JSON.parse(r.body), method).to.deep.equal({ route: "any-all", method });
      }
    });

    it("a method specific route still wins over ALL, whichever was registered first", async () => {
      expect(JSON.parse((await request(port, "GET", "/mixed")).body).route).to.equal("mixed-get");
      expect(JSON.parse((await request(port, "GET", "/mixed2")).body).route).to.equal("mixed2-get");
      expect(JSON.parse((await request(port, "POST", "/mixed", "{}")).body).route).to.equal("mixed-all");
      expect(JSON.parse((await request(port, "PUT", "/mixed2", "{}")).body).route).to.equal("mixed2-all");
    });
  });
});
