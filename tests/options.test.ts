import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { ActiveOptions } from "../packages/options/src";

/**
 * ActiveOptions is the single source of configuration for every process, and
 * extendConfig() is how a node adopts the network's agreed security,
 * consensus, hybrid and neighbourhood settings from the ledger. Getting the
 * merge wrong makes nodes vote differently, so the precedence and the merge
 * rules are pinned here against a real config file and a real HTTP endpoint.
 */
describe("ActiveOptions", () => {
  const argv = process.argv;
  const g: any = global;
  let savedConfig: any;
  let savedArgv: any;
  let dir: string;

  const restore = (target: any, saved: any) => {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, saved);
  };

  beforeEach(() => {
    savedConfig = { ...ActiveOptions.fetch(false) };
    savedArgv = { ...ActiveOptions.fetch(true) };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-options-"));
  });

  afterEach(() => {
    process.argv = argv;
    restore(ActiveOptions.fetch(false), savedConfig);
    restore(ActiveOptions.fetch(true), savedArgv);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("get()", () => {
    it("prefers config over CLI over the default", () => {
      process.argv = ["node", "x", "--alpha", "cli", "--beta", "cli"];
      ActiveOptions.init();
      ActiveOptions.set("alpha", "config");

      expect(ActiveOptions.get("alpha", "def")).to.equal("config");
      expect(ActiveOptions.get("beta", "def")).to.equal("cli");
      expect(ActiveOptions.get("gamma", "def")).to.equal("def");
      expect(ActiveOptions.get("gamma")).to.equal(null);
    });

    it("treats falsy but defined config values as set", () => {
      process.argv = ["node", "x", "--flag"];
      ActiveOptions.init();
      ActiveOptions.set("flag", false);
      ActiveOptions.set("count", 0);

      expect(ActiveOptions.get("flag", true)).to.equal(false);
      expect(ActiveOptions.get("count", 5)).to.equal(0);
    });

    it("falls through to CLI when a config value is explicitly null", () => {
      process.argv = ["node", "x", "--alpha", "cli"];
      ActiveOptions.init();
      ActiveOptions.set("alpha", null);
      expect(ActiveOptions.get("alpha", "def")).to.equal("cli");
    });
  });

  describe("init()", () => {
    it("parses CLI flags, numbers and positionals", () => {
      process.argv = ["node", "x", "--port", "5260", "--debug", "run"];
      ActiveOptions.init();
      const parsed: any = ActiveOptions.fetch(true);
      expect(parsed.port).to.equal(5260);
      expect(parsed.debug).to.equal("run");
    });
  });

  describe("parseConfig()", () => {
    it("reads the file named by --config, records its name and exposes globals", () => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ network: "abc@1-x", db: { url: "u" } }));
      process.argv = ["node", "x", "--config", file];
      ActiveOptions.init();
      ActiveOptions.parseConfig();

      expect(ActiveOptions.get("network")).to.equal("abc@1-x");
      expect(ActiveOptions.get("__filename")).to.equal(file);
      expect(g.config).to.equal(ActiveOptions.fetch(false));
      expect(g.argv).to.equal(ActiveOptions.fetch(true));
    });

    it("throws on a missing or malformed config file", () => {
      process.argv = ["node", "x", "--config", path.join(dir, "missing.json")];
      ActiveOptions.init();
      expect(() => ActiveOptions.parseConfig()).to.throw();

      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, "{ not json");
      process.argv = ["node", "x", "--config", bad];
      ActiveOptions.init();
      expect(() => ActiveOptions.parseConfig()).to.throw(SyntaxError);
    });
  });

  describe("extendConfig()", () => {
    let server: http.Server;
    let document: any;
    let requested: string;

    beforeEach((done) => {
      requested = "";
      document = null;
      server = http.createServer((req, res) => {
        requested = req.url as string;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(document));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        ActiveOptions.set("db", { url: `http://127.0.0.1:${port}`, database: "ledger" });
        ActiveOptions.set("network", "netstream@1-old");
        done();
      });
    });

    afterEach((done) => {
      server.close(() => done());
    });

    it("asks the database for the network stream id taken from before the @", async () => {
      document = { _id: "netstream", _rev: "2-new" };
      await ActiveOptions.extendConfig();
      expect(requested).to.equal("/ledger/netstream");
    });

    it("merges security, consensus, neighbourhood and the new revision from the ledger", async () => {
      document = {
        _id: "netstream",
        _rev: "2-new",
        security: { signedOutputs: true },
        consensus: { reached: 66 },
        neighbourhood: { neighbour: [] },
        hybrid: { enabled: true },
      };
      const result = await ActiveOptions.extendConfig();

      expect(result).to.deep.equal(document);
      expect(ActiveOptions.get("network")).to.equal("netstream@2-new");
      expect(ActiveOptions.get("security")).to.deep.equal({ signedOutputs: true });
      expect(ActiveOptions.get("consensus")).to.deep.equal({ reached: 66 });
      expect(ActiveOptions.get("neighbourhood")).to.deep.equal({ neighbour: [] });
      expect(ActiveOptions.get("hybrid")).to.deep.equal({ enabled: true });
    });

    it("leaves local sections alone when the ledger omits them, except hybrid", async () => {
      ActiveOptions.set("security", { local: true });
      ActiveOptions.set("consensus", { local: true });
      ActiveOptions.set("hybrid", { enabled: true });
      document = { _id: "netstream", _rev: "3-x" };
      await ActiveOptions.extendConfig();

      expect(ActiveOptions.get("security")).to.deep.equal({ local: true });
      expect(ActiveOptions.get("consensus")).to.deep.equal({ local: true });
      // A stale local hybrid section must not make nodes differ from the ledger
      expect(ActiveOptions.get("hybrid", "absent")).to.equal("absent");
    });

    it("returns the document without applying it when automerge is false", async () => {
      document = { _id: "netstream", _rev: "9-z", security: { x: 1 } };
      const result = await ActiveOptions.extendConfig(false);

      expect(result).to.deep.equal(document);
      expect(ActiveOptions.get("network")).to.equal("netstream@1-old");
      expect(ActiveOptions.get("security", "unset")).to.equal("unset");
    });

    it("keeps the old network revision when the ledger document carries none", async () => {
      document = { _id: "netstream" };
      await ActiveOptions.extendConfig();
      expect(ActiveOptions.get("network")).to.equal("netstream@1-old");
    });

    it("resolves false rather than rejecting when the ledger cannot be read", async () => {
      await new Promise((resolve) => server.close(resolve));
      expect(await ActiveOptions.extendConfig()).to.equal(false);
    });
  });
});
