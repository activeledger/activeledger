import { expect } from "chai";
import * as http from "http";
import * as net from "net";
import { ActiveRequest, ContractScope } from "@activeledger/activeutilities";
import { runSandboxed, runUnsandboxed } from "../packages/protocol/src/protocol/sandbox";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareAllDocs } = require("../packages/storage/src/selfhost-helpers.js");

const NEVER = ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror", "activeledgererrors_archive", "activeledgererror_archive"];

describe("redteam: contract storage guard", function () {
  this.timeout(120000);
  let storage: http.Server, other: http.Server, port = 0, otherPort = 0;
  const seen: { method: string; url: string; body: string }[] = [];
  let redirectTo = "";

  before(async () => {
    storage = http.createServer((q, s) => {
      let b = ""; q.on("data", (c) => (b += c));
      q.on("end", () => { seen.push({ method: q.method!, url: q.url!, body: b }); s.setHeader("content-type", "application/json"); s.end('{"ok":true}'); });
    });
    other = http.createServer((q, s) => { s.statusCode = 307; s.setHeader("location", redirectTo); s.end(); });
    await Promise.all([storage, other].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
    port = (storage.address() as net.AddressInfo).port;
    otherPort = (other.address() as net.AddressInfo).port;
    ContractScope.protectPorts([port]);
    ContractScope.neverDatabases(NEVER);
  });
  after(() => { storage.close(); other.close(); });
  beforeEach(() => { seen.length = 0; });

  const inContract = <T>(fn: () => T) =>
    runSandboxed({ mode: "storage", customDatabases: true, onBlocked: () => {} }, fn);
  const tryReq = async (...a: Parameters<typeof ActiveRequest.send>) => {
    try { await inContract(() => ActiveRequest.send(...a)); } catch { /* refused */ }
  };

  // What the real storage would do with the request line + body
  const storageView = (r: { method: string; url: string; body: string }): string | null => {
    const [p, q = ""] = r.url.split("?");
    const seg = p.split("/").filter(Boolean);
    const dec = (s: string) => { let c = s; for (let i = 0; i < 6; i++) { try { const n = decodeURIComponent(c); if (n === c) break; c = n; } catch { break; } } return c; };
    const stripq = (s: string) => s.replace(/"/g, "");
    const texts = [p, q, r.body].map((t) => stripq(dec(t)));
    let parsed: any; try { parsed = JSON.parse(r.body); } catch { parsed = undefined; }
    if (parsed) texts.push(stripq(JSON.stringify(parsed).replace(/\\"/g, "")), stripq(dec(String(parsed.startkey ?? ""))) , stripq(String(parsed.endkey ?? "")));
    if (texts.some((t) => /volatile/i.test(t))) return "volatile";
    if (seg.length && (NEVER.includes(seg[0]))) return "node db";
    if (seg[0]?.startsWith("_") ) return "root route " + seg[0];
    if (seg.length === 1 && r.method !== "GET") return "db create/drop";
    if (seg[1]?.startsWith("_") && seg[1] !== "_all_docs" && seg[1] !== "_bulk_docs") return "admin " + seg[1];
    return null;
  };
  const report = () => seen.map((r) => ({ r, bad: storageView(r) })).filter((x) => x.bad);

  it("quote-stripping: startkey/endkey/keys with a quote inside the word reach the store as 'volatile'", async () => {
    const base = `http://127.0.0.1:${port}/activeledger_x/_all_docs`;
    await tryReq(`${base}?startkey=vo%22latile&endkey=vo%22latile`, "GET");
    await tryReq(base, "POST", undefined, { startkey: 'vo"latile', endkey: 'vo"latile' });
    console.log("RECEIVED", JSON.stringify(seen));
    // What storage does to it
    const opts = prepareAllDocs({ startkey: 'vo"latile', endkey: 'vo"latile' });
    console.log("STORAGE EFFECTIVE", JSON.stringify(opts));
    expect(seen.length, "requests that reached the store").to.equal(0);
  });

  it("brute force path/url shapes: nothing that the storage reads as forbidden reaches it", async () => {
    const dbs = ["activeledger", "ActiveLedger", "activeledgerevents", "activeledgererrors", "activeledger_x", "activeledger.", "activeledger%00", "%61ctiveledger", "activeledger%20", "activeledger;"];
    const tails = ["", "/", "/x", "/x:volatile", "/_all_docs", "/_bulk_docs", "/_backup", "/%5Fbackup", "/_raw/x", "/_prune", "/_compact", "/%2e/_backup", "/./_restore", "/x/../_backup", "/x%2F..%2F_backup", "/_ALL_DOCS", "/_all_docs/", "/_all_docs;a", "/x?x=y#_backup", "/%76olatile", "/%2576olatile", "/vol\tatile", "/vol%0Aatile", "/v%C0%AFolatile", "/%EF%BC%B6olatile", "/volatile"];
    const prefixes = ["/", "//", "/./", "/x/../", "/;/../", "/%2e%2e/", "\\", "/\\", "/%5c"];
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `[::ffff:127.0.0.1]:${port}`, `2130706433:${port}`, `0x7f.1:${port}`, `127.1:${port}`, `localhost.:${port}`, `a@127.0.0.1:${port}`, `127.0.0.1:0${port}`, `0:${port}`, `0.0.0.0:${port}`];
    const methods = ["GET", "get", "PUT", "POST", "DELETE", "HEAD", "OPTIONS", "M-SEARCH", "CONNECT", "PATCH", "PROPFIND"];
    let n = 0;
    const jobs: Promise<void>[] = [];
    for (const h of hosts) for (const db of dbs) for (const t of tails) for (const pf of prefixes.slice(0, 3)) {
      for (const m of ["GET", "POST", "put", "DELETE"]) { n++; jobs.push(tryReq(`http://${h}${pf}${db}${t}`, m, undefined, m === "GET" ? undefined : {})); }
      if (jobs.length > 200) await Promise.all(jobs.splice(0));
    }
    for (const pf of prefixes) for (const db of dbs.slice(0, 6)) for (const t of tails) for (const m of methods) { n++; jobs.push(tryReq(`http://${hosts[0]}${pf}${db}${t}`, m)); if (jobs.length > 200) await Promise.all(jobs.splice(0)); }
    await Promise.all(jobs);
    const bad = report().filter((x) => !/^(HEAD|OPTIONS)$/.test(x.r.method));
    console.log("sent", n, "received", seen.length, "BAD", bad.length);
    for (const b of bad.slice(0, 15)) console.log(" BAD", b.bad, b.r.method, b.r.url, b.r.body);
    expect(bad.length).to.equal(0);
  });

  it("redirect from a public-looking server to the storage port is not followed", async () => {
    redirectTo = `http://127.0.0.1:${port}/activeledger/x:volatile`;
    await tryReq(`http://127.0.0.1:${otherPort}/`, "GET");
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).to.equal(0);
  });

  it("bodies: toJSON/getters/odd types", async () => {
    const mk = (b: any) => tryReq(`http://127.0.0.1:${port}/activeledger_x`, "POST", undefined, b);
    const u = `http://127.0.0.1:${port}/activeledger_x/_bulk_docs`;
    let n = 0;
    const flip = { toJSON() { return n++ ? { _id: "a:volatile" } : { a: 1 }; } };
    await tryReq(u, "POST", undefined, flip);
    await tryReq(u, "POST", undefined, new Uint16Array([0x7b, 0x7d]));
    await tryReq(u, "POST", undefined, new DataView(new ArrayBuffer(4)));
    await tryReq(u, "POST", ["Content-Type: application/json", "Content-Length: 2"], '{"docs":[{"_id":"v\\u006flatile"}]}');
    await tryReq(u, "POST", ["Transfer-Encoding : chunked"], "{}");
    await tryReq(u, "POST", ["Content-Encoding\t: gzip"], "{}");
    await tryReq(u, "POST", ["x:y", "Host: 127.0.0.1:1"], '{"docs":[]}');
    await tryReq(u, "POST", ["X-HTTP-Method-Override: DELETE"], '{"docs":[]}');
    await tryReq(u, "POST", undefined, '{"docs":[{"_id":"a","_deleted":true}]}'.repeat(1));
    await mk(undefined);
    console.log("bodies received", seen.length, JSON.stringify(report()));
    expect(report().length).to.equal(0);
  });
});
