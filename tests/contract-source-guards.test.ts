import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "../packages/options/lib";
import { expect } from "chai";
import "mocha";

// The deploy scan's rules about storage and local services written into contract source.
// Static, build-gated (50600), and the same on every node.
function scan(source: string, namespace = "somenamespace"): string | null {
  try {
    Contract.prototype.securityScan.call({}, source, namespace);
    return null;
  } catch (e: any) {
    return e.message;
  }
}
const wrap = (body: string) => `export default class Foo { vote() { ${body} } }`;

describe("Contract.securityScan() - storage and local service rules (build 50600)", () => {
  let before: any, beforeSecurity: any;
  beforeEach(() => {
    before = ActiveOptions.get<number>("build", 0);
    beforeSecurity = ActiveOptions.get<any>("security", undefined);
    ActiveOptions.set("build", 50600);
  });
  afterEach(() => {
    ActiveOptions.set("build", before);
    ActiveOptions.set("security", beforeSecurity);
  });

  it("refuses a path that names volatile data, in any spelling", () => {
    for (const s of [
      "http://127.0.0.1:5259/activeledger/abc:volatile",
      "/activeledger_w/abc:VOLATILE",
      "/activeledger_w/abc%3Avolatile",
      "/activeledger_w/abc%253Avolatile",
      "/x/\\u0076olatile",
      "https://example.com/data/volatile",
    ]) expect(scan(wrap(`return "${s}";`)), s).to.include("volatile");
    expect(scan(wrap("return `/activeledger_w/${id}:volatile`;")), "template").to.include("volatile");
  });

  it("leaves the word volatile alone when it is not a path (calls, messages, names)", () => {
    expect(scan(wrap('return this.getVolatile("k");'))).to.equal(null);
    expect(scan(wrap('throw new Error("volatile data is missing");'))).to.equal(null);
    expect(scan(wrap('return { volatile: 1 };'))).to.equal(null);
  });

  it("leaves a stream id that ends in :volatile alone when it goes straight to getAnyStreamReadOnly", () => {
    for (const body of [
      "return this.getAnyStreamReadOnly(`${keyId}:volatile`);",
      'return this.getAnyStreamReadOnly("abc:volatile");',
      "return this.getAnyStreamReadOnly(id + ':volatile');",
      "return this.getAnyStreamReadOnly((`${id}:volatile`));",
      "return getAnyStreamReadOnly(`${id}:volatile`);",
      "return Promise.all(ids.map((i) => this.getAnyStreamReadOnly(`${i}:volatile`)));",
    ]) expect(scan(wrap(body)), body).to.equal(null);
  });

  it("still refuses volatile text anywhere else, including a request and a path", () => {
    for (const body of [
      "return HTTP.send(`${id}:volatile`);",
      'return client.request({ url: "x:volatile" });',
      "return client.get(`${base}/${id}:volatile`);",
      'return HTTP.send(url, "POST", [], { _id: "abc:volatile", v: 1 });',
      "return `/activeledger_w/${id}:volatile`;",
      "return this.getAnyStreamReadOnly(`/db/${id}:volatile`);",
      "return this.somethingElse(`${id}:volatile`);",
      'return this.getAnyStreamReadOnly("abc:volatile", client.send("x:volatile"));',
    ]) expect(scan(wrap(body)), body).to.include("volatile");
  });

  it("refuses a URL to this machine unless the namespace has allowLocalhost", () => {
    for (const s of ["http://127.0.0.1:5259/x", "http://localhost:8080/", "http://[::1]:5259/x", "//localhost:1/x", "localhost:5290/p", "http://0.0.0.0:80/", "http://user@127.1.2.3/x"]) {
      expect(scan(wrap(`return "${s}";`)), s).to.include("allowLocalhost");
    }
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowLocalhost: true } } } });
    expect(scan(wrap('return "http://127.0.0.1:5290/x";'))).to.equal(null);
    // Not a flag a string can turn on
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowLocalhost: "yes" } } } });
    expect(scan(wrap('return "http://127.0.0.1:5290/x";'))).to.include("allowLocalhost");
  });

  it("leaves other URLs and words alone", () => {
    for (const s of ["https://example.com/a", "http://10.0.0.5/x", "localhost", "my localhost note", "127 items"]) {
      expect(scan(wrap(`return "${s}";`)), s).to.equal(null);
    }
  });

  it("refuses connection options on a request call", () => {
    for (const key of ["agent", "createConnection", "dispatcher", "lookup", "socketPath", "setHost"]) {
      expect(scan(wrap(`return client.send({ ${key}: 1 });`)), key).to.include(key);
      expect(scan(wrap(`return client.request({ "${key}": 1 });`)), key).to.include(key);
    }
    // Same names elsewhere are the contract's own
    expect(scan(wrap("return this.keep({ lookup: 1 });"))).to.equal(null);
    expect(scan(wrap("const o = { agent: 1 }; return o;"))).to.equal(null);
  });

  it("refuses a custom database path unless the namespace has allowDatabases, and the node's own always", () => {
    for (const s of ["/activeledger_wallets/abc", "/activeledger_wallets/_all_docs", "/activeledgerfoo/x"]) {
      expect(scan(wrap(`return "${s}";`)), s).to.include("allowDatabases");
    }
    for (const s of ["/activeledger/abc", "/activeledgerevents/_all_docs", "/activeledgererrors/x"]) {
      expect(scan(wrap(`return "${s}";`)), s).to.include("own database");
    }
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowDatabases: true } } } });
    expect(scan(wrap('return "/activeledger_wallets/abc";'))).to.equal(null);
    expect(scan(wrap('return "/activeledger/abc";'))).to.include("own database");
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowDatabases: "yes" } } } });
    expect(scan(wrap('return "/activeledger_wallets/abc";'))).to.include("allowDatabases");
    // A list names the databases: others are still refused
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowDatabases: ["activeledger_wallets"] } } } });
    expect(scan(wrap('return "/activeledger_wallets/abc";'))).to.equal(null);
    expect(scan(wrap('return "/activeledger_deposits/abc";'))).to.include("allowDatabases");
    ActiveOptions.set("security", { namespace: { somenamespace: { policy: { allowDatabases: ["*"] } } } });
    expect(scan(wrap('return "/activeledger_deposits/abc";'))).to.equal(null);
    // A public host's path is not the node's storage (a repository link, a docs page)
    ActiveOptions.set("security", {});
    for (const s of ["https://github.com/activeledger/activeledger", "https://example.com/activeledger-docs/page", "https://github.com/activeledger/activeledger-sdk-js"]) expect(scan(wrap(`return "${s}";`)), s).to.equal(null);
    // Prose and types that say volatile are not paths
    for (const s of ["Error: volatile data missing", "Stream: volatile", "see https://docs.activeledger.io/guide for volatile data"]) expect(scan(wrap(`return "${s}";`)), s).to.equal(null);
    expect(scan('type K = "state:volatile"; export default class Foo { vote() { return 1; } }')).to.equal(null);
    // Words and short paths are not databases
    for (const s of ["activeledger_wallets", "/activeledger", "see /docs/activeledger", "an activeledger/x note"]) expect(scan(wrap(`return "${s}";`)), s).to.equal(null);
  });

  it("is off below build 50600, so a network that has not moved on votes as before", () => {
    ActiveOptions.set("build", 50599);
    expect(scan(wrap('return "http://127.0.0.1:5259/x:volatile";'))).to.equal(null);
    expect(scan(wrap("return client.send({ agent: 1 });"))).to.equal(null);
  });

  it("gives the same answer whatever the node's storage port is", () => {
    const a = scan(wrap('return "http://127.0.0.1:5259/x";'));
    ActiveOptions.set("db", { selfhost: { port: 1234 } });
    expect(scan(wrap('return "http://127.0.0.1:5259/x";'))).to.equal(a);
  });

  it("does not scan the default namespace, as before", () => {
    expect(scan(wrap('return "http://127.0.0.1:5259/x:volatile";'), "default")).to.equal(null);
  });
});
