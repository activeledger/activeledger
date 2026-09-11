import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as zlib from "zlib";
import { ActiveRequest } from "../packages/utilities/src";

/**
 * Behavioural coverage for ActiveRequest.send(), the single function every
 * database operation and every node-to-node knock goes through.
 *
 * request-keepalive.test.ts asserts the dispatcher's timeout constants, which
 * says nothing about what send() does with a response. That mattered when
 * send() was rewritten from undici's request() to dispatch(): the JSON, gzip
 * and failure paths were all reimplemented by hand with nothing asserting
 * them, and the gzip path in particular is only reached by the hybrid node
 * flow (host.ts's hybridHosts loop), which neither test suite exercises.
 *
 * The contract worth protecting is stranger than a normal HTTP client's:
 * send() must NEVER reject. Callers read { data: null } to mean failure -
 * neighbour.knock() and checkNeighbourhood() decide a node is down that way -
 * so a rejection would surface as an unhandled rejection rather than a node
 * being marked unreachable.
 */
describe("ActiveRequest.send", () => {
  let server: http.Server;
  let base: string;
  let lastRequest: { method?: string; headers: http.IncomingHttpHeaders; body: Buffer };

  /** Set per test to decide how the server answers. */
  let respond: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

  before((done) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastRequest = { method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
        respond(req, res, Buffer.concat(chunks));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      done();
    });
  });

  after((done) => server.close(() => done()));

  const json = (payload: unknown) => (_req: any, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  it("returns the parsed JSON body of a GET", async () => {
    respond = json({ ok: true, rows: [1, 2, 3] });
    const result = await ActiveRequest.send(`${base}/x`, "GET");
    expect(result.data).to.deep.equal({ ok: true, rows: [1, 2, 3] });
  });

  it("sends an object body as JSON, with the content type set", async () => {
    respond = json({ ok: true });
    await ActiveRequest.send(`${base}/x`, "POST", undefined, { keys: ["a", "b"] });
    expect(lastRequest.method).to.equal("POST");
    expect(lastRequest.headers["content-type"]).to.equal("application/json");
    expect(JSON.parse(lastRequest.body.toString())).to.deep.equal({ keys: ["a", "b"] });
  });

  it("forwards caller supplied headers", async () => {
    respond = json({ ok: true });
    await ActiveRequest.send(`${base}/x`, "POST", ["X-Activeledger:node-ref"], { a: 1 });
    expect(lastRequest.headers["x-activeledger"]).to.equal("node-ref");
  });

  it("decompresses a gzipped response", async () => {
    const payload = { compressed: true, streams: ["a", "b"] };
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
    };
    const result = await ActiveRequest.send(`${base}/x`, "GET", undefined, undefined, true);
    expect(result.data).to.deep.equal(payload);
  });

  it("gzips a request body once it is worth compressing", async () => {
    respond = json({ ok: true });
    // Comfortably over GZIP_MIN_BYTES (1024), and compressible.
    const big = { blob: "a".repeat(4096) };
    await ActiveRequest.send(`${base}/x`, "POST", undefined, big, true);
    expect(lastRequest.headers["content-encoding"]).to.equal("gzip");
    expect(JSON.parse(zlib.gunzipSync(lastRequest.body).toString())).to.deep.equal(big);
  });

  it("leaves a small body uncompressed, where gzip would cost more than it saves", async () => {
    respond = json({ ok: true });
    await ActiveRequest.send(`${base}/x`, "POST", undefined, { small: true }, true);
    expect(lastRequest.headers["content-encoding"]).to.be.undefined;
    expect(JSON.parse(lastRequest.body.toString())).to.deep.equal({ small: true });
  });

  it("resolves { data: null } when the host is unreachable, rather than rejecting", async () => {
    // Port 1 on loopback: nothing listens, and the connection is refused
    // rather than hanging.
    const result = await ActiveRequest.send("http://127.0.0.1:1/x", "GET");
    expect(result.data).to.equal(null);
  });

  it("resolves { data: null } for a malformed URL", async () => {
    const result = await ActiveRequest.send("not-a-url", "GET");
    expect(result.data).to.equal(null);
  });

  it("resolves { data: null } when the body is not JSON", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("this is not json");
    };
    const result = await ActiveRequest.send(`${base}/x`, "GET");
    expect(result.data).to.equal(null);
  });

  it("still returns the parsed body of a non-2xx response", async () => {
    // Deliberate: dsconnect treats a 404 as an answer ("no such document"),
    // not an error, so a failing status must not be turned into null.
    respond = (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    };
    const result = await ActiveRequest.send(`${base}/x`, "GET");
    expect(result.data).to.deep.equal({ error: "not_found" });
  });

  it("handles a response split across many chunks", async () => {
    const payload = { rows: Array.from({ length: 500 }, (_, i) => ({ id: i })) };
    const raw = Buffer.from(JSON.stringify(payload));
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < raw.length; i += 64) res.write(raw.subarray(i, i + 64));
      res.end();
    };
    const result = await ActiveRequest.send(`${base}/x`, "GET");
    expect(result.data).to.deep.equal(payload);
  });
});
