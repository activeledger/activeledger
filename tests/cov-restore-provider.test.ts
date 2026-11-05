import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Helper } from "../packages/restore/src/modules/helper/helper";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork, ActiveInterfaces } from "@activeledger/activenetwork";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Provider start-up, with ActiveOptions replaced by a plain map and the
 * network constructor replaced, so nothing real is opened.
 */
describe("Restore Provider (cov)", () => {
  let opts: Record<string, any>;
  let sets: [string, any][];
  let calls: string[];
  let extendFails: any;
  let output: string[];
  let errors: any[];
  let fatals: any[];
  const keep: any = {};
  const P: any = Provider;
  let tmp: string;
  let identityFile: string;

  beforeEach(() => {
    opts = {};
    sets = [];
    calls = [];
    output = [];
    errors = [];
    fatals = [];
    extendFails = undefined;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-provider-"));
    for (const k of ["init", "get", "set", "parseConfig", "extendConfig"]) keep[k] = (ActiveOptions as any)[k];
    keep.output = Helper.output;
    keep.error = (ActiveLogger as any).error;
    keep.fatal = (ActiveLogger as any).fatal;
    for (const k of ["isSelfhost", "database", "errorDatabase", "errorArchive", "eventDatabase", "network", "isQuickFullRestore", "neighbourCount", "consensusReachedAmount"]) keep["P" + k] = P[k];
    keep.fetch = (ActiveOptions as any).fetch;
    keep.home = ["identity", "publicPem", "reference", "host", "left", "right"].map((k) => [k, (ActiveNetwork.Home as any)[k]]);
    keep.bindingPort = (ActiveInterfaces as any).bindingPort;
    keep.bindingHost = (ActiveInterfaces as any).bindingHost;
    (ActiveInterfaces as any).bindingPort = undefined;
    (ActiveOptions as any).fetch = (argv: boolean) => (argv ? {} : { host: "127.0.0.1:5260" });
    const gen: any = new ActiveCrypto.KeyPair("rsa").generate();
    const idFile = path.join(tmp, "identity-file");
    fs.writeFileSync(idFile, JSON.stringify({ prv: { pkcs8pem: gen.prv.pkcs8pem }, pub: { pkcs8pem: gen.pub.pkcs8pem } }));
    identityFile = idFile;
    (ActiveOptions as any).init = () => calls.push("init");
    (ActiveOptions as any).get = (k: string, d: any) => (k in opts ? opts[k] : d);
    (ActiveOptions as any).set = (k: string, v: any) => sets.push([k, v]);
    (ActiveOptions as any).parseConfig = () => calls.push("parse");
    (ActiveOptions as any).extendConfig = async () => {
      calls.push("extend");
      if (extendFails) throw extendFails;
    };
    (Helper as any).output = (m: string) => output.push(m);
    (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
    (ActiveLogger as any).fatal = (...a: any[]) => fatals.push(a);
  });

  afterEach(() => {
    for (const k of ["init", "get", "set", "parseConfig", "extendConfig"]) (ActiveOptions as any)[k] = keep[k];
    (Helper as any).output = keep.output;
    (ActiveLogger as any).error = keep.error;
    (ActiveLogger as any).fatal = keep.fatal;
    for (const k of ["isSelfhost", "database", "errorDatabase", "errorArchive", "eventDatabase", "network", "isQuickFullRestore", "neighbourCount", "consensusReachedAmount"]) P[k] = keep["P" + k];
    (ActiveOptions as any).fetch = keep.fetch;
    for (const [k, v] of keep.home) (ActiveNetwork.Home as any)[k] = v;
    (ActiveInterfaces as any).bindingPort = keep.bindingPort;
    (ActiveInterfaces as any).bindingHost = keep.bindingHost;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("setConfigData sets the option and says so", () => {
    P.setConfigData("k", "v");
    expect(sets).to.deep.equal([["k", "v"]]);
    expect(output).to.deep.equal(["Setting k"]);
  });

  describe("getConfig", () => {
    it("uses the default config name and no path, then parses and extends in order", async () => {
      await P.getConfig();
      expect(sets).to.deep.equal([]);
      expect(calls).to.deep.equal(["parse", "extend"]);
      expect(output).to.include("Using default config");
      expect(output).to.include("No path provided");
    });
    it("prefixes a given path onto the config name", async () => {
      opts.path = "/etc/al/";
      opts.config = "my.json";
      await P.getConfig();
      expect(sets).to.deep.equal([["config", "/etc/al/my.json"]]);
      expect(output).to.include("Config provided");
    });
    it("reports a config file that exists", async () => {
      const f = path.join(tmp, "c.json");
      fs.writeFileSync(f, "{}");
      opts.config = f;
      await P.getConfig();
      expect(output).to.include("Config file found");
    });
    it("rejects when extending the config fails", async () => {
      extendFails = new Error("bad config");
      let err: any;
      try {
        await P.getConfig();
      } catch (e) {
        err = e;
      }
      expect(err).to.equal(extendFails);
      expect(output).to.not.include("Config Extended");
    });
  });

  describe("getIdentity", () => {
    it("takes the identity from <path>/.identity when one is asked for", async () => {
      opts.identity = true;
      opts.path = tmp;
      fs.writeFileSync(path.join(tmp, ".identity"), "x");
      await P.getIdentity();
      expect(sets).to.deep.equal([["identity", tmp + "/.identity"]]);
      expect(output).to.include("Identity path found");
    });
    it("only reports when no identity is asked for", async () => {
      await P.getIdentity();
      expect(sets).to.deep.equal([]);
      expect(output).to.include("No identity found");
    });
  });

  describe("database set up", () => {
    it("self hosting points at the local port and the data dir", () => {
      const cfg: any = { selfhost: { port: 5984, dir: "/data" }, url: "http://remote" };
      P.setupSelfHostDB(cfg);
      expect(P.isSelfhost).to.equal(true);
      expect(cfg.url).to.equal("http://127.0.0.1:5984");
      expect(cfg.path).to.equal("/data");
      expect(sets).to.deep.equal([["db", cfg]]);
    });
    it("self hosting defaults the data dir to ./.ds", () => {
      const cfg: any = { selfhost: { port: 1 } };
      P.setupSelfHostDB(cfg);
      expect(cfg.path).to.equal("./.ds");
    });
    it("a normal restore opens the live, error, archive and event databases", async () => {
      opts.db = { url: "http://h:1", database: "ledger", error: "errs" };
      opts.identity = identityFile;
      opts.neighbourhood = [];
      await P.setupDatabase();
      expect(P.isSelfhost).to.not.equal(true);
      expect(output).to.include("Not using self hosted database");
      expect(P.network).to.be.instanceOf(ActiveNetwork.Home);
      expect(P.database).to.be.instanceOf(ActiveDSConnect);
      expect(P.database.location).to.equal("http://h:1/ledger");
      expect(P.errorDatabase.location).to.equal("http://h:1/errs");
      expect(P.errorArchive.location).to.equal("http://h:1/errs_archive");
      expect(P.eventDatabase.location).to.equal("http://h:1/errs");
      expect(P.isQuickFullRestore).to.equal(false);
    });
    it("a full restore opens only the live database", async () => {
      opts.db = { url: "http://h:1", database: "ledger", error: "errs" };
      opts.full = true;
      opts.identity = identityFile;
      opts.neighbourhood = [];
      P.errorDatabase = undefined;
      P.eventDatabase = undefined;
      await P.setupDatabase();
      expect(P.isQuickFullRestore).to.equal(true);
      expect(P.database.location).to.equal("http://h:1/ledger");
      expect(P.errorDatabase).to.equal(undefined);
      expect(P.eventDatabase).to.equal(undefined);
    });
    it("a self hosted config is rewritten before the connections are made", async () => {
      opts.db = { selfhost: { port: 7 }, database: "ledger", error: "errs" };
      opts.identity = identityFile;
      opts.neighbourhood = [];
      await P.setupDatabase();
      expect(P.isSelfhost).to.equal(true);
      expect(P.database.location).to.equal("http://127.0.0.1:7/ledger");
    });
  });

  describe("getConsensusData", () => {
    it("counts neighbours and reads the consensus percentage", async () => {
      opts.neighbourhood = [1, 2, 3];
      opts.consensus = { reached: 66 };
      await P.getConsensusData();
      expect(P.neighbourCount).to.equal(3);
      expect(P.consensusReachedAmount).to.equal(66);
    });
    it("is zero neighbours and an unset consensus with no config", async () => {
      await P.getConsensusData();
      expect(P.neighbourCount).to.equal(0);
      expect(P.consensusReachedAmount).to.equal(undefined);
    });
  });

  describe("initialise", () => {
    it("runs the steps in order and resolves", async () => {
      opts.db = { url: "u", database: "d", error: "e" };
      opts.identity = identityFile;
      opts.neighbourhood = [];
      fs.writeFileSync(path.join(tmp, ".identity"), fs.readFileSync(identityFile));
      opts.path = tmp;
      opts.consensus = { reached: 51 };
      await Provider.initialise();
      expect(calls).to.deep.equal(["init", "parse", "extend"]);
      expect(P.neighbourCount).to.equal(0);
      expect(P.consensusReachedAmount).to.equal(51);
      expect(P.database).to.be.instanceOf(ActiveDSConnect);
    });
    it("logs the error and never resolves when a step fails", async () => {
      extendFails = new Error("bad");
      let resolved = false;
      Provider.initialise().then(() => (resolved = true));
      await new Promise((r) => setTimeout(r, 30));
      expect(resolved).to.equal(false);
      expect(errors.length).to.equal(1);
      expect(errors[0][0]).to.equal(extendFails);
    });
  });
});
