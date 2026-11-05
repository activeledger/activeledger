import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import * as zlib from "zlib";
import { ActiveOptions, ActiveRequest } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Home } from "../packages/network/src/network/home";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { Neighbourhood } from "../packages/network/src/network/neighbourhood";

describe("Neighbour knock edge cases (cov)", () => {
  const own = new ActiveCrypto.KeyPair("rsa");
  own.generate();
  const remoteKeys = new ActiveCrypto.KeyPair("rsa").generate();
  const saved: any = {};
  let server: http.Server;
  let port: number;
  let requests: { headers: http.IncomingHttpHeaders; body: string }[];
  let warnings: string[];
  let fatals: any[][];
  const realSend = ActiveRequest.send;

  before((done) => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    Home.reference = "home-ref";
    Home.identity = own;
    Maintain.pairNow = () => undefined;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
        requests.push({ headers: req.headers, body: body.toString() });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: 1 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });
  after((done) => {
    Home.reference = saved.reference;
    Home.identity = saved.identity;
    Maintain.pairNow = saved.pairNow;
    server.close(() => done());
  });

  let realWarn: any;
  let realFatal: any;
  beforeEach(() => {
    requests = [];
    warnings = [];
    fatals = [];
    saved.security = ActiveOptions.get("security", undefined);
    saved.network = ActiveOptions.get("network", undefined);
    ActiveOptions.set("security", {});
    ActiveOptions.set("network", "");
    realWarn = (ActiveLogger as any).warn;
    realFatal = (ActiveLogger as any).fatal;
    (ActiveLogger as any).warn = (m: string) => warnings.push(String(m));
    (ActiveLogger as any).fatal = (...a: any[]) => (fatals.push(a), new Error("fatal"));
  });
  afterEach(() => {
    ActiveOptions.set("security", saved.security);
    ActiveOptions.set("network", saved.network);
    (ActiveLogger as any).warn = realWarn;
    (ActiveLogger as any).fatal = realFatal;
    ActiveRequest.send = realSend;
    (Neighbour as any).simulatedRttMs = 0;
    (Neighbour as any).rttAnnounced = false;
  });

  const neighbour = (p = port, isHome = true) =>
    new Neighbour("127.0.0.1", p, isHome, new ActiveCrypto.KeyPair("rsa", remoteKeys.pub.pkcs8pem));

  describe("simulated round trip (profiling)", () => {
    it("delays each knock by half the round trip and announces itself once", async () => {
      (Neighbour as any).simulatedRttMs = 60;
      const n = neighbour();
      const t0 = Date.now();
      await n.knock("status");
      const first = Date.now() - t0;
      await n.knock("status");
      expect(first).to.be.at.least(25);
      expect(warnings).to.deep.equal(["SIMULATED RTT ACTIVE: 60ms - profiling only"]);
      expect(requests).to.have.length(2);
    });

    it("is inert when not configured", async () => {
      const n = neighbour();
      const t0 = Date.now();
      await n.knock("status");
      expect(Date.now() - t0).to.be.lessThan(25);
      expect(warnings).to.deep.equal([]);
    });
  });

  describe("bundling", () => {
    it("sends a full bundle of 100 at once", async () => {
      const n = neighbour();
      const windows: any[] = [];
      const cleared: any[] = [];
      const realSet = global.setTimeout;
      const realClear = global.clearTimeout;
      (global as any).setTimeout = (fn: any, ms: number, ...a: any[]) => {
        const h = realSet(fn, ms, ...a);
        if (ms === 5) windows.push(h);
        return h;
      };
      (global as any).clearTimeout = (h: any) => {
        cleared.push(h);
        return realClear(h);
      };
      const sends: Promise<any>[] = [];
      try {
        for (let i = 0; i < 100; i++) sends.push(n.knock("init", { $umid: "b" + i }, false, 0, true));
      } finally {
        global.setTimeout = realSet;
        global.clearTimeout = realClear;
      }
      await Promise.all(sends);
      // the 100th knock cancelled the short window and sent straight away
      expect(windows).to.have.length(1);
      expect(cleared).to.include(windows[0]);
      await new Promise((r) => setTimeout(r, 80));
      expect(requests).to.have.length(1);
      expect(requests[0].headers["x-bundle"]).to.equal("1");
      const wire = JSON.parse(requests[0].body);
      const parts = Buffer.from(wire.data).toString().split(":$ALB:");
      expect(parts).to.have.length(100);
      expect((n as any).bundle).to.deep.equal([]);
      expect((n as any).nextSend).to.equal(null);
    });

    it("holds 99 for the short window instead", async () => {
      const n = neighbour();
      const sends: Promise<any>[] = [];
      for (let i = 0; i < 99; i++) sends.push(n.knock("init", { $umid: "c" + i }, false, 0, true));
      await Promise.all(sends);
      expect(requests).to.have.length(0);
      await new Promise((r) => setTimeout(r, 120));
      expect(requests).to.have.length(1);
      expect(Buffer.from(JSON.parse(requests[0].body).data).toString().split(":$ALB:")).to.have.length(99);
    });
  });

  describe("when the transport itself throws", () => {
    const failWith = (...errors: any[]) => {
      let calls = 0;
      ActiveRequest.send = (async () => {
        const e = errors[Math.min(calls, errors.length - 1)];
        calls++;
        if (e && e.__ok) return { data: { ok: 1 } };
        throw e;
      }) as any;
      return () => calls;
    };

    it("hands back the body of an HTTP error response", async () => {
      failWith({ response: { data: "denied by peer" } });
      const n = neighbour();
      let err: any;
      try {
        await n.knock("init", { $umid: "x" });
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("denied by peer");
      expect(n.isHome).to.equal(true);
    });

    it("resends after a reset connection, up to the allowed attempts, then succeeds", async () => {
      const calls = failWith({ code: "ECONNRESET" }, { code: "ECONNRESET" }, { __ok: true });
      const n = neighbour();
      const r = await n.knock("init", { $umid: "x" }, false, 2);
      expect(r).to.deep.equal({ data: { ok: 1 } });
      expect(calls()).to.equal(3);
      expect(warnings).to.deep.equal([
        "Network Issue : Resending due to unexpected closed socket",
        "Network Issue : Resending due to unexpected closed socket",
      ]);
      expect(n.isHome).to.equal(true);
    });

    it("gives up after resend+1 attempts, marks the node down and rejects", async () => {
      const calls = failWith({ code: "ECONNRESET" });
      const n = neighbour();
      let err: any;
      try {
        await n.knock("init", { $umid: "x" }, false, 2);
      } catch (e) {
        err = e;
      }
      n.graceStop = true; // stop recovery polling
      expect(err).to.equal("Network Communication Error");
      expect(calls()).to.equal(4);
      expect(n.isHome).to.equal(false);
      expect(fatals).to.have.length(1);
      expect(fatals[0][1]).to.equal(`Network Error - 127.0.0.1:${port}/init`);
    });

    it("does not resend a reset connection when no resend was asked for, nor other errors", async () => {
      const calls = failWith({ code: "ETIMEDOUT" });
      const n = neighbour();
      let err: any;
      try {
        await n.knock("init", { $umid: "x" }, false, 5);
      } catch (e) {
        err = e;
      }
      n.graceStop = true;
      expect(err).to.equal("Network Communication Error");
      expect(calls()).to.equal(1);
    });

    it("a bundled send that fails is swallowed rather than rejected", async () => {
      failWith(new Error("socket hang up"));
      const n = neighbour();
      await n.knock("init", { $umid: "x" }, false, 0, true);
      await new Promise((r) => setTimeout(r, 60));
      n.graceStop = true;
      expect(n.isHome).to.equal(false);
      expect(warnings.filter((w) => w === "X-Bundle Error")).to.deep.equal([]);
    });
  });

  describe("recovery monitoring", () => {
    it("starts once for a node that is down", () => {
      const n: any = neighbour(port, false);
      let polls = 0;
      n.recoveryCheck = () => polls++;
      n.ensureMonitored();
      n.ensureMonitored();
      expect(polls).to.equal(1);
      expect(n.recovering).to.equal(true);
    });

    it("does nothing for a node that is home or leaving", () => {
      let polls = 0;
      const home: any = neighbour(port, true);
      home.recoveryCheck = () => polls++;
      home.ensureMonitored();
      const leaving: any = neighbour(port, false);
      leaving.graceStop = true;
      leaving.recoveryCheck = () => polls++;
      leaving.ensureMonitored();
      expect(polls).to.equal(0);
      expect(home.recovering).to.not.equal(true);
      expect(leaving.recovering).to.not.equal(true);
    });
  });
});

describe("Neighbourhood.add with a list (cov)", () => {
  const key = new ActiveCrypto.KeyPair("rsa").generate().pub.pkcs8pem;
  const entry = (host: string) => ({ host, port: 5260, identity: { type: "rsa", public: key } });
  let savedHood: any;
  let savedNetwork: any;
  let nh: any;

  beforeEach(() => {
    savedHood = ActiveOptions.get("neighbourhood", undefined);
    savedNetwork = ActiveOptions.get("network", undefined);
    ActiveOptions.set("network", "");
    ActiveOptions.set("neighbourhood", [entry("10.2.0.1")]);
    nh = new Neighbourhood();
  });
  afterEach(() => {
    ActiveOptions.set("neighbourhood", savedHood);
    ActiveOptions.set("network", savedNetwork);
  });

  it("adds new neighbours with their firewall entries in both directions", () => {
    const a = new Neighbour("10.2.0.2", 5260);
    const b = new Neighbour("10.2.0.3", 5260);
    const before = nh.houses;
    nh.add([a, b]);
    expect(nh.houses).to.equal(before + 2);
    expect(nh.neighbours[a.reference]).to.equal(a);
    expect(nh.firewall["10.2.0.2"]).to.equal(a.reference);
    expect(nh.firewall[a.reference]).to.equal("10.2.0.2");
    expect(nh.firewall["10.2.0.3"]).to.equal(b.reference);
    expect(nh.checkFirewall("10.2.0.3")).to.equal(true);
  });

  it("does not add a known neighbour again but lets a leaving one back in", () => {
    const existing = Object.values(nh.neighbours)[0] as Neighbour;
    existing.graceStop = true;
    const houses = nh.houses;
    nh.add([new Neighbour("10.2.0.1", 5260)]);
    expect(nh.houses).to.equal(houses);
    expect(nh.neighbours[existing.reference]).to.equal(existing);
    expect(existing.graceStop).to.equal(false);
  });

  it("adding a single known neighbour also lets a leaving one back in", () => {
    const existing = Object.values(nh.neighbours)[0] as Neighbour;
    existing.graceStop = true;
    nh.add(new Neighbour("10.2.0.1", 5260));
    expect(existing.graceStop).to.equal(false);
    expect(nh.houses).to.equal(1);
  });
});

describe("Neighbour full bundle to an unreachable node (cov)", () => {
  const own = new ActiveCrypto.KeyPair("rsa");
  own.generate();
  const remoteKeys = new ActiveCrypto.KeyPair("rsa").generate();
  const saved: any = {};
  let warnings: string[];
  let realWarn: any;
  let realFatal: any;

  beforeEach(() => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    saved.security = ActiveOptions.get("security", undefined);
    saved.network = ActiveOptions.get("network", undefined);
    Home.reference = "home-ref";
    Home.identity = own;
    Maintain.pairNow = () => undefined;
    ActiveOptions.set("security", {});
    ActiveOptions.set("network", "");
    warnings = [];
    realWarn = (ActiveLogger as any).warn;
    realFatal = (ActiveLogger as any).fatal;
    (ActiveLogger as any).warn = (m: string) => warnings.push(String(m));
    (ActiveLogger as any).fatal = () => new Error("fatal");
  });
  afterEach(() => {
    Home.reference = saved.reference;
    Home.identity = saved.identity;
    Maintain.pairNow = saved.pairNow;
    ActiveOptions.set("security", saved.security);
    ActiveOptions.set("network", saved.network);
    (ActiveLogger as any).warn = realWarn;
    (ActiveLogger as any).fatal = realFatal;
  });

  it("logs the failed bundle and marks the node down", async () => {
    const dead = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const n = new Neighbour("127.0.0.1", dead, true, new ActiveCrypto.KeyPair("rsa", remoteKeys.pub.pkcs8pem));
    const sends: Promise<any>[] = [];
    for (let i = 0; i < 100; i++) sends.push(n.knock("init", { $umid: "d" + i }, false, 0, true));
    await Promise.all(sends);
    for (let i = 0; i < 50 && n.isHome; i++) await new Promise((r) => setTimeout(r, 20));
    n.graceStop = true; // stop the recovery poll
    expect(n.isHome).to.equal(false);
    expect(warnings.filter((w) => w === "X-Bundle Error")).to.deep.equal(["X-Bundle Error"]);
  });
});
