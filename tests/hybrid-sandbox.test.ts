import {
  runSandboxed,
  runUnsandboxed,
  installSandbox,
} from "../packages/protocol/src/protocol/sandbox";
import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";

// On a hybrid, contracts cannot make outbound network calls. They load
// modules with plain require(), so the block lives in the process, scoped to
// the contract's execution.
describe("Hybrid egress sandbox (Activeprotocol)", () => {
  const net = require("net");
  const tls = require("tls");
  const dgram = require("dgram");
  const https = require("https");
  // The module object itself, as a contract's require() sees it
  const httpm = require("http");

  let server: http.Server;
  let port: number;

  before((done) => {
    installSandbox();
    server = http.createServer((_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  after((done) => {
    server.close(() => done());
  });

  const blocked = (fn: () => unknown) => {
    const seen: string[] = [];
    let error: any;
    try {
      runSandboxed({ onBlocked: (what) => seen.push(what) }, fn);
    } catch (e) {
      error = e;
    }
    return { seen, error };
  };

  const cases: [string, string, () => unknown][] = [
    ["http", "http.request", () => httpm.request("http://127.0.0.1:1/")],
    ["http", "http.get", () => httpm.get("http://127.0.0.1:1/")],
    ["https", "https.request", () => https.request("https://127.0.0.1:1/")],
    ["https", "https.get", () => https.get("https://127.0.0.1:1/")],
    ["net", "net.connect", () => net.connect(1, "127.0.0.1")],
    ["net", "net.createConnection", () => net.createConnection(1, "127.0.0.1")],
    ["net", "new net.Socket().connect", () => new net.Socket().connect(1, "127.0.0.1")],
    ["tls", "tls.connect", () => tls.connect(1, "127.0.0.1")],
    ["dgram", "dgram.createSocket", () => dgram.createSocket("udp4")],
    ["fetch", "fetch", () => fetch("http://127.0.0.1:1/")],
  ];

  for (const [what, label, call] of cases) {
    it(`blocks ${label} with SupernodeOnly and reports ${what}`, () => {
      const { seen, error } = blocked(call);
      expect(error, "should throw").to.be.instanceOf(Error);
      expect(error.name).to.equal("SupernodeOnly");
      expect(seen).to.deep.equal([what]);
    });
  }

  it("still blocks after the contract awaits (timers and promises)", async () => {
    const seen: string[] = [];
    const error = await runSandboxed(
      { onBlocked: (what) => seen.push(what) },
      () =>
        new Promise<any>((resolve) =>
          setTimeout(async () => {
            await Promise.resolve();
            try {
              net.connect(port, "127.0.0.1");
              resolve(null);
            } catch (e) {
              resolve(e);
            }
          }, 1)
        )
    );
    expect(error?.name).to.equal("SupernodeOnly");
    expect(seen).to.deep.equal(["net"]);
  });

  it("catches a socket a library opens for the contract", () => {
    // Any client socket ends at net.Socket.prototype.connect
    const { seen, error } = blocked(() => {
      const socket = new net.Socket();
      return socket.connect({ port, host: "127.0.0.1" });
    });
    expect(error?.name).to.equal("SupernodeOnly");
    expect(seen).to.deep.equal(["net"]);
  });

  it("leaves the rest of the process alone", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    expect(body).to.equal("ok");
  });

  it("lets host work a contract triggers run unsandboxed", async () => {
    const body = await runSandboxed({ onBlocked: () => {} }, () =>
      runUnsandboxed(
        () =>
          new Promise<string>((resolve, reject) => {
            http
              .get(`http://127.0.0.1:${port}/`, (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => resolve(data));
              })
              .on("error", reject);
          })
      )
    );
    expect(body).to.equal("ok");
  });

  it("does not block server sockets", () => {
    const { error } = blocked(() => http.createServer());
    expect(error).to.equal(undefined);
  });
});
