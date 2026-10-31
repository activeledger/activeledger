import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Home } from "../packages/network/src/network/home";
import { Neighbour } from "../packages/network/src/network/neighbour";
import {
  Neighbourhood,
  NeighbourStatus,
} from "../packages/network/src/network/neighbourhood";
import { ActiveInterfaces } from "../packages/network/src/network/utils";

// Home reads its identity file and the neighbourhood from ActiveOptions, so
// each test builds a real Home from a temporary identity file and a config
// with three nodes (this one and two others), then puts everything back.
// Processors are plain fakes that record what Home sends them.
describe("Home (this node within the neighbourhood)", () => {
  const sha1 = (s: string) => ActiveCrypto.Hash.getHash(s, "sha1");
  const HOST = "127.0.0.1";
  const PORT = 5260;
  const OTHERS: [string, number][] = [
    ["127.0.0.2", 5260],
    ["127.0.0.3", 5260],
  ];
  const refOf = (host: string, port: number, network = "") =>
    sha1(host + port + network);

  // Key generation is slow, so make the keys once
  const own = new ActiveCrypto.KeyPair("rsa").generate(2048, true);
  const peer = new ActiveCrypto.KeyPair("rsa").generate(2048, true);

  const OPTION_KEYS = [
    "host",
    "identity",
    "neighbourhood",
    "proxy",
    "network",
    "security",
    "consensus",
    "p2pStream",
  ];

  let tmpDir: string;
  let saved: any;
  let savedStatics: any;
  let savedRemap: any;

  const iface = ActiveInterfaces as any;
  const resetBinding = () => {
    iface.bindingHost = undefined;
    iface.bindingPort = undefined;
  };

  const neighbourhoodConfig = (self = true) =>
    [...(self ? [[HOST, PORT] as [string, number]] : []), ...OTHERS].map(
      ([host, port]) => ({
        host,
        port,
        identity: { type: "rsa", public: peer.pub.pkcs8pem },
      })
    );

  const makeHome = (): any => new Home();

  // The subclass that owns the processes provides the standby process
  const withStandby = (home: any): any => {
    home.standbyProcess = fakeProcessor(1);
    return home;
  };

  const fakeProcessor = (pid: number, killed = false): any => {
    const p: any = { pid, killed, sent: [] as any[] };
    p.send = (m: any) => p.sent.push(m);
    return p;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-home-test-"));
    const idFile = path.join(tmpDir, ".identity");
    fs.writeFileSync(idFile, JSON.stringify({ prv: own.prv, pub: own.pub }));

    const config = ActiveOptions.fetch(false);
    saved = {};
    for (const k of OPTION_KEYS) saved[k] = config[k];
    savedStatics = {
      identity: Home.identity,
      publicPem: Home.publicPem,
      left: Home.left,
      right: Home.right,
      reference: Home.reference,
      host: Home.host,
    };
    savedRemap = Neighbourhood.remapedAddr;

    config.host = `${HOST}:${PORT}`;
    config.identity = idFile;
    config.neighbourhood = neighbourhoodConfig();
    delete config.proxy;
    delete config.network;
    delete config.security;
    delete config.p2pStream;
    config.consensus = { reached: 66 };
    resetBinding();
    Neighbourhood.remapedAddr = {};
    (Home as any).left = undefined;
    (Home as any).right = undefined;
  });

  afterEach(() => {
    const config = ActiveOptions.fetch(false);
    for (const k of OPTION_KEYS) {
      if (saved[k] === undefined) delete config[k];
      else config[k] = saved[k];
    }
    Object.assign(Home, savedStatics);
    Neighbourhood.remapedAddr = savedRemap;
    resetBinding();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("construction", () => {
    it("takes its address, reference and host label from the binding", () => {
      const home = makeHome();
      expect(home.host).to.equal(HOST);
      expect(home.port).to.equal(PORT);
      expect(home.reference).to.equal(refOf(HOST, PORT));
      expect(Home.reference).to.equal(home.reference);
      expect(Home.host).to.equal(`${HOST}:${PORT}`);
    });

    it("includes the network name in the reference", () => {
      ActiveOptions.fetch(false).network = "testnet-a";
      const home = makeHome();
      expect(home.reference).to.equal(refOf(HOST, PORT, "testnet-a"));
    });

    it("loads the identity and exposes the public pem base64 encoded", () => {
      makeHome();
      expect(Buffer.from(Home.publicPem, "base64").toString()).to.equal(
        own.pub.pkcs8pem
      );
      // The loaded key is the one from the file, not a fresh one
      const sig = Home.identity.sign("payload");
      const verifier = new ActiveCrypto.KeyPair("rsa", own.pub.pkcs8pem);
      expect(verifier.verify("payload", sig)).to.equal(true);
    });

    it("rebuilds the reference from the proxy address when behind a proxy", () => {
      const config = ActiveOptions.fetch(false);
      config.proxy = "203.0.113.9:5260";
      config.network = "net";
      const home = makeHome();
      expect(home.reference).to.equal(sha1(HOST + "203.0.113.9:5260" + "net"));
      expect(home.reference).to.not.equal(refOf(HOST, PORT, "net"));
      expect(Home.reference).to.equal(home.reference);
    });

    it("uses the remapped reference when this address has been remapped", () => {
      Neighbourhood.remapedAddr = { [refOf(HOST, PORT)]: "remapped-ref" };
      const home = makeHome();
      expect(home.reference).to.equal("remapped-ref");
      expect(Home.reference).to.equal("remapped-ref");
    });

    it("starts with itself as both neighbours", () => {
      const home = makeHome();
      expect(Home.left.reference).to.equal(home.reference);
      expect(Home.right.reference).to.equal(home.reference);
    });

    it("keeps neighbours it already has", () => {
      const left = new Neighbour("127.0.0.2", 5260);
      (Home as any).left = left;
      makeHome();
      expect(Home.left).to.equal(left);
    });

    it("fails when the identity file is missing", () => {
      ActiveOptions.fetch(false).identity = path.join(tmpDir, "nope");
      expect(() => makeHome()).to.throw(/ENOENT/);
    });
  });

  describe("sign and decrypt", () => {
    it("does not sign unless asked or signedConsensus is set", () => {
      makeHome();
      expect(Home.sign("data")).to.equal(null);
      ActiveOptions.fetch(false).security = { signedConsensus: false };
      expect(Home.sign("data")).to.equal(null);
    });

    it("signs when signedConsensus is on, verifiable by the public key", () => {
      makeHome();
      ActiveOptions.fetch(false).security = { signedConsensus: true };
      const sig = Home.sign("data") as string;
      expect(sig).to.be.a("string");
      const verifier = new ActiveCrypto.KeyPair("rsa", own.pub.pkcs8pem);
      expect(verifier.verify("data", sig)).to.equal(true);
      expect(verifier.verify("other", sig)).to.equal(false);
    });

    it("signs when forced even if signedConsensus is off", () => {
      makeHome();
      expect(Home.sign("data", true)).to.be.a("string");
    });

    it("decrypts what was encrypted to its public key", () => {
      const home = makeHome();
      const sender = new ActiveCrypto.KeyPair("rsa", own.pub.pkcs8pem);
      const cipher = sender.encrypt("secret message");
      expect(cipher).to.not.equal("secret message");
      expect(home.decrypt(cipher)).to.equal("secret message");
    });
  });

  describe("getStatus", () => {
    it("is Stable on a single node network where it is its own neighbour", () => {
      ActiveOptions.fetch(false).neighbourhood = [
        neighbourhoodConfig()[0],
      ];
      const home = makeHome();
      expect(home.neighbourhood.count()).to.equal(1);
      expect(home.getStatus()).to.equal(NeighbourStatus.Stable);
    });

    it("is Unrecognised when alone with others in the neighbourhood", () => {
      const home = makeHome();
      expect(home.neighbourhood.count()).to.equal(3);
      expect(home.getStatus()).to.equal(NeighbourStatus.Unrecognised);
    });

    it("is Pairing with only one real neighbour", () => {
      const home = withStandby(makeHome());
      home.setRight(refOf(...OTHERS[0]));
      expect(home.getStatus()).to.equal(NeighbourStatus.Pairing);
    });

    it("is Stable with both neighbours found and neither is itself", () => {
      const home = withStandby(makeHome());
      home.setNeighbours(refOf(...OTHERS[1]), refOf(...OTHERS[0]));
      expect(home.getStatus()).to.equal(NeighbourStatus.Stable);
    });
  });

  describe("territoriality map", () => {
    const refs = () => [HOST, ...OTHERS.map((o) => o[0])]
      .map((h) => refOf(h, PORT))
      .sort();

    it("names the node that must be entered for a commit at each node", () => {
      const home = makeHome();
      const sorted = refs();
      // 66% of 3 nodes needs 2 votes, so the entry node is one place before
      // the commit node, wrapping round the circle
      sorted.forEach((commitAt, i) => {
        expect(home.terriMap(commitAt)).to.equal(
          sorted[(i - 1 + sorted.length) % sorted.length]
        );
      });
    });

    it("is the commit node itself when one vote is enough", () => {
      ActiveOptions.fetch(false).consensus = { reached: 1 };
      const home = makeHome();
      refs().forEach((r) => expect(home.terriMap(r)).to.equal(r));
    });

    it("needs every node when consensus is 100%", () => {
      ActiveOptions.fetch(false).consensus = { reached: 100 };
      const home = makeHome();
      const sorted = refs();
      // 3 votes of 3: entry is two places before the commit node
      sorted.forEach((commitAt, i) => {
        expect(home.terriMap(commitAt)).to.equal(
          sorted[(i - 2 + sorted.length) % sorted.length]
        );
      });
    });

    it("returns an empty string for a node it does not know", () => {
      const home = makeHome();
      expect(home.terriMap("not-a-node")).to.equal("");
    });

    it("leaves out nodes that are stopping gracefully", () => {
      const home = makeHome();
      const stopping = refOf(...OTHERS[1]);
      home.neighbourhood.get(stopping).graceStop = true;
      home.terriBuildMap();
      expect(home.terriMap(stopping)).to.equal("");
      // Two nodes left; 66% of 2 is 2 votes, so entry is the other node
      const left = [refOf(HOST, PORT), refOf(...OTHERS[0])].sort();
      expect(home.terriMap(left[0])).to.equal(left[1]);
      expect(home.terriMap(left[1])).to.equal(left[0]);
    });
  });

  describe("setting neighbours", () => {
    let home: any;
    let processors: any[];
    let standby: any;

    beforeEach(() => {
      home = makeHome();
      processors = [fakeProcessor(101), fakeProcessor(102)];
      standby = fakeProcessor(103);
      home.processors = processors;
      home.standbyProcess = standby;
    });

    it("sets the right neighbour, marks it home and tells every processor", () => {
      const ref = refOf(...OTHERS[0]);
      home.setRight(ref);
      expect(Home.right).to.equal(home.neighbourhood.get(ref));
      expect(Home.right.isHome).to.equal(true);
      for (const p of [...processors, standby]) {
        expect(p.sent).to.have.length(1);
        expect(p.sent[0].type).to.equal("hk");
        expect(p.sent[0].data.right).to.deep.include({
          host: OTHERS[0][0],
          port: OTHERS[0][1],
          reference: ref,
          isHome: true,
          graceStop: false,
        });
      }
    });

    it("sets the left neighbour without messaging processors", () => {
      const ref = refOf(...OTHERS[1]);
      home.setLeft(ref);
      expect(Home.left).to.equal(home.neighbourhood.get(ref));
      expect(Home.left.isHome).to.equal(true);
      for (const p of [...processors, standby]) expect(p.sent).to.deep.equal([]);
    });

    it("sets both with setNeighbours and ignores null sides", () => {
      const l = refOf(...OTHERS[1]);
      const r = refOf(...OTHERS[0]);
      home.setNeighbours(l, null);
      expect(Home.left.reference).to.equal(l);
      expect(Home.right.reference).to.equal(home.reference);
      home.setNeighbours(null, r);
      expect(Home.right.reference).to.equal(r);
      expect(Home.left.reference).to.equal(l);
    });

    it("ignores a neighbour that is not in the neighbourhood yet", () => {
      const before = { l: Home.left, r: Home.right };
      home.setRight("unknown");
      home.setLeft("unknown");
      expect(Home.right).to.equal(before.r);
      expect(Home.left).to.equal(before.l);
      for (const p of [...processors, standby]) expect(p.sent).to.deep.equal([]);
    });

    it("falls back to itself when the chosen neighbour is stopping", () => {
      const ref = refOf(...OTHERS[0]);
      home.neighbourhood.get(ref).graceStop = true;
      home.setRight(ref);
      home.setLeft(ref);
      expect(Home.right.reference).to.equal(home.reference);
      expect(Home.left.reference).to.equal(home.reference);
      // The processors are still told, with the fallback
      expect(processors[0].sent[0].data.right.reference).to.equal(
        home.reference
      );
    });
  });

  describe("findProcessor", () => {
    it("finds a live processor by pid", () => {
      const home = makeHome();
      const a = fakeProcessor(11);
      const b = fakeProcessor(12);
      home.processors = [a, b];
      expect(home.findProcessor(12)).to.equal(b);
    });

    it("does not return killed processors or unknown pids", () => {
      const home = makeHome();
      home.processors = [fakeProcessor(11, true), fakeProcessor(12)];
      expect(home.findProcessor(11)).to.equal(undefined);
      expect(home.findProcessor(99)).to.equal(undefined);
    });
  });
});
