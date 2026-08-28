import { ActiveHttpd } from "../packages/httpd/src/httpd";
import { expect } from "chai";
import "mocha";
import * as http from "http";

// Regression coverage for the hpe-14 perf fix (3620b36) that skips
// URLSearchParams parsing on requests with no query string (every internal
// consensus POST, none of which ever carry one) - and, incidentally, for
// ActiveHttpd's now-unconditional CORS headers (825db4e, the dead
// enableCORS flag removal).
describe("ActiveHttpd - hpe-14 regressions", () => {
  const PORT = 5701;
  let httpd: ActiveHttpd;

  before((done) => {
    httpd = new ActiveHttpd();
    httpd.use("/test", "GET", async (incoming: any) => {
      // The handler's return value is passed straight through as the
      // response body (writeResponse() JSON.stringifies a plain object
      // itself) - not a {statusCode, content} envelope.
      return { query: incoming.query };
    });
    httpd.listen(PORT);
    // listen() itself doesn't return a promise - give the underlying
    // uWS server a moment to actually bind before the first request.
    setTimeout(done, 200);
  });

  after(() => {
    httpd.shutdown();
  });

  function get(path: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port: PORT, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
      }).on("error", reject);
    });
  }

  it("returns an empty query object for a request with no query string (3620b36)", async () => {
    const res = await get("/test");
    expect(JSON.parse(res.body)).to.deep.equal({ query: {} });
  });

  it("still correctly parses a real query string", async () => {
    const res = await get("/test?foo=bar&baz=qux");
    expect(JSON.parse(res.body)).to.deep.equal({ query: { foo: "bar", baz: "qux" } });
  });

  it("still writes CORS headers unconditionally with no constructor argument (825db4e)", async () => {
    const res = await get("/test");
    expect(res.headers["access-control-allow-origin"]).to.equal("*");
    expect(res.headers["access-control-allow-methods"]).to.equal("GET, POST");
    expect(res.headers["access-control-allow-headers"]).to.equal("*");
  });
});
