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
});
