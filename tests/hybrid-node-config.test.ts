import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  mergeFlags,
  parseUpstream,
  validateConfig,
} from "../packages/hybrid/src/config";

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(ConfigError);
    return (e as ConfigError).errors;
  }
  throw new Error("expected a ConfigError");
};

describe("hybrid config", () => {
  describe("validateConfig", () => {
    it("fills every default from an empty object", () => {
      expect(validateConfig({})).to.deep.equal({
        upstreams: [],
        peers: [],
        bind: "127.0.0.1",
        port: 5270,
        window: { days: 30 },
        maxLagSeconds: null,
        refuseOnboard: true,
      });
      expect(validateConfig({})).to.deep.equal(defaultConfig());
    });

    it("accepts the full documented shape", () => {
      const full = {
        upstreams: [{ host: "10.0.0.1", port: 5260, transport: "p2p" }],
        peers: [{ host: "::1", port: 5270, transport: "http" }],
        bind: "0.0.0.0",
        port: 6000,
        token: "secret",
        window: { days: 7 },
        maxLagSeconds: 60,
        refuseOnboard: false,
        events: { contracts: ["c1"], where: { kind: "deposit" } },
        submit: { contracts: ["c2"] },
      };
      expect(validateConfig(full)).to.deep.equal(full);
    });

    it("defaults an endpoint transport to http", () => {
      expect(validateConfig({ upstreams: [{ host: "a", port: 1 }] }).upstreams).to.deep.equal([
        { host: "a", port: 1, transport: "http" },
      ]);
    });

    it("does not alias the input", () => {
      const raw = { events: { contracts: ["a"] } };
      const cfg = validateConfig(raw);
      cfg.events!.contracts!.push("b");
      expect(raw.events.contracts).to.deep.equal(["a"]);
    });

    it("rejects a non-object", () => {
      for (const v of [null, [], "x", 3]) {
        expect(errorsOf(() => validateConfig(v))[0]).to.match(/^config: expected an object/);
      }
    });

    it("rejects unknown keys at every level", () => {
      expect(
        errorsOf(() =>
          validateConfig({
            upstream: [],
            window: { days: 1, hours: 2 },
            events: { contract: [] },
            submit: { where: {} },
            upstreams: [{ host: "a", port: 1, secure: true }],
          })
        )
      ).to.have.members([
        "upstream: unknown key",
        "window.hours: unknown key",
        "events.contract: unknown key",
        "submit.where: unknown key",
        "upstreams[0].secure: unknown key",
      ]);
    });

    it("reports each wrong type precisely, all at once", () => {
      const errors = errorsOf(() =>
        validateConfig({
          upstreams: {},
          peers: [{ host: "", port: 70000, transport: "udp" }, "x"],
          bind: 1,
          port: "5270",
          token: 5,
          window: { days: 0 },
          maxLagSeconds: -1,
          refuseOnboard: "yes",
          events: { contracts: ["a", 2], where: { kind: 1, ok: "y" } },
          submit: { contracts: "c" },
        })
      );
      expect(errors).to.have.members([
        "upstreams: expected an array, got object",
        "peers[0].host: expected a non-empty string",
        "peers[0].port: expected an integer from 1 to 65535, got 70000",
        'peers[0].transport: expected "p2p" or "http", got "udp"',
        "peers[1]: expected an object {host, port, transport}, got string",
        "bind: expected a non-empty string, got 1",
        'port: expected an integer from 1 to 65535, got "5270"',
        "token: expected a non-empty string, got number",
        "window.days: expected a positive number, got 0",
        "maxLagSeconds: expected a positive number or null, got -1",
        "refuseOnboard: expected a boolean, got string",
        "events.contracts[1]: expected a non-empty string, got 2",
        "events.where.kind: expected a string, got number",
        "submit.contracts: expected an array of strings, got string",
      ]);
    });

    it("checks port boundaries", () => {
      for (const port of [1, 65535]) expect(validateConfig({ port }).port).to.equal(port);
      for (const port of [0, 65536, 1.5, -1, NaN]) {
        expect(errorsOf(() => validateConfig({ port }))[0]).to.match(/^port:/);
      }
    });

    it("accepts maxLagSeconds null explicitly", () => {
      expect(validateConfig({ maxLagSeconds: null }).maxLagSeconds).to.equal(null);
    });

    it("rejects an empty token and a non-object events.where", () => {
      expect(errorsOf(() => validateConfig({ token: "" }))[0]).to.match(/^token:/);
      expect(errorsOf(() => validateConfig({ events: { where: ["a"] } }))[0]).to.equal(
        "events.where: expected an object of field: value, got array"
      );
    });
  });

  describe("loadConfig", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-config-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("reads and validates a file", () => {
      const f = path.join(dir, "hybrid.json");
      fs.writeFileSync(f, JSON.stringify({ port: 6001, upstreams: [{ host: "h", port: 5260, transport: "http" }] }));
      const cfg = loadConfig(f);
      expect(cfg.port).to.equal(6001);
      expect(cfg.bind).to.equal("127.0.0.1");
    });

    it("names an unreadable file, bad JSON and invalid content", () => {
      expect(errorsOf(() => loadConfig(path.join(dir, "missing.json")))[0]).to.match(/missing\.json: cannot read \(ENOENT\)/);
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, "{ nope");
      expect(errorsOf(() => loadConfig(bad))[0]).to.match(/bad\.json: not valid JSON/);
      const wrong = path.join(dir, "wrong.json");
      fs.writeFileSync(wrong, JSON.stringify({ port: 0 }));
      expect(errorsOf(() => loadConfig(wrong))[0]).to.match(/^port:/);
    });
  });

  describe("parseUpstream", () => {
    it("parses host:port with an optional transport, default http", () => {
      expect(parseUpstream("example.com:5260")).to.deep.equal({ host: "example.com", port: 5260, transport: "http" });
      expect(parseUpstream("10.0.0.1:5261:p2p")).to.deep.equal({ host: "10.0.0.1", port: 5261, transport: "p2p" });
      expect(parseUpstream("h:1:http")).to.deep.equal({ host: "h", port: 1, transport: "http" });
    });

    it("parses bracketed IPv6", () => {
      expect(parseUpstream("[::1]:5260")).to.deep.equal({ host: "::1", port: 5260, transport: "http" });
      expect(parseUpstream("[fe80::1:2]:5261:p2p")).to.deep.equal({ host: "fe80::1:2", port: 5261, transport: "p2p" });
    });

    it("rejects malformed values with the reason", () => {
      const cases: [string, RegExp][] = [
        ["", /empty/],
        ["host", /missing port/],
        [":5260", /missing host/],
        ["h:", /port "" is not 1 to 65535/],
        ["h:0", /port "0"/],
        ["h:65536", /port "65536"/],
        ["h:12ab", /port "12ab"/],
        ["h:5260:udp", /transport "udp" is not p2p or http/],
        ["h:1:http:x", /too many parts/],
        ["::1:5260", /put an IPv6 address in brackets/],
        ["[::1:5260", /unclosed \[/],
        ["[]:5260", /empty IPv6/],
        ["[::1]5260", /missing port/],
      ];
      for (const [v, re] of cases) {
        const [msg] = errorsOf(() => parseUpstream(v));
        expect(msg, v).to.match(re);
        expect(msg).to.match(/expected host:port\[:p2p\|http\]/);
      }
    });
  });

  describe("mergeFlags", () => {
    const base = () =>
      validateConfig({
        upstreams: [{ host: "file", port: 1, transport: "p2p" }],
        port: 6000,
        maxLagSeconds: 10,
        events: { contracts: ["c"] },
      });

    it("lets flags override the file without changing it", () => {
      const cfg = base();
      const merged = mergeFlags(cfg, {
        "max-lag-seconds": "30",
        port: 7000,
        host: "0.0.0.0",
        token: "t",
        "window-days": "2",
        "refuse-onboard": "false",
      });
      expect(merged).to.include({ port: 7000, bind: "0.0.0.0", token: "t", maxLagSeconds: 30, refuseOnboard: false });
      expect(merged.window).to.deep.equal({ days: 2 });
      expect(cfg.port).to.equal(6000);
      expect(cfg.maxLagSeconds).to.equal(10);
    });

    it("replaces upstreams with repeatable --upstream", () => {
      expect(mergeFlags(base(), { upstream: "a:1" }).upstreams).to.deep.equal([{ host: "a", port: 1, transport: "http" }]);
      expect(mergeFlags(base(), { upstream: ["a:1:p2p", "[::1]:2"] }).upstreams).to.deep.equal([
        { host: "a", port: 1, transport: "p2p" },
        { host: "::1", port: 2, transport: "http" },
      ]);
      expect(mergeFlags(base(), { peer: ["p:3"] }).peers).to.deep.equal([{ host: "p", port: 3, transport: "http" }]);
    });

    it("leaves the file's values without the flag, and ignores non-config flags", () => {
      const merged = mergeFlags(base(), { config: "x.json", debug: true, _: ["start"] } as any);
      expect(merged).to.deep.equal(base());
    });

    it("clears maxLagSeconds with null or none", () => {
      expect(mergeFlags(base(), { "max-lag-seconds": "null" }).maxLagSeconds).to.equal(null);
      expect(mergeFlags(base(), { "max-lag-seconds": "none" }).maxLagSeconds).to.equal(null);
    });

    it("takes the last of a repeated single-value flag", () => {
      expect(mergeFlags(base(), { port: [7000, 7001] }).port).to.equal(7001);
    });

    it("maps the nested filter flags", () => {
      const m = mergeFlags(base(), { "events-where": ["kind:deposit", "a:b:c"], "submit-contract": "s" });
      expect(m.events).to.deep.equal({ contracts: ["c"], where: { kind: "deposit", a: "b:c" } });
      expect(m.submit).to.deep.equal({ contracts: ["s"] });
      expect(mergeFlags(base(), { "events-contract": ["x", "y"] }).events!.contracts).to.deep.equal(["x", "y"]);
    });

    it("names the flag at fault", () => {
      expect(errorsOf(() => mergeFlags(base(), { port: "abc" }))).to.deep.equal(['--port: expected a number, got "abc"']);
      expect(errorsOf(() => mergeFlags(base(), { "refuse-onboard": "maybe" }))[0]).to.match(/^--refuse-onboard:/);
      expect(errorsOf(() => mergeFlags(base(), { upstream: ["ok:1", "bad"] }))[0]).to.match(/^--upstream: upstream "bad": missing port/);
      expect(errorsOf(() => mergeFlags(base(), { "events-where": "nocolon" }))[0]).to.match(/^--events-where:/);
      expect(errorsOf(() => mergeFlags(base(), { host: true }))[0]).to.equal("--host: expected a value");
      // A parsed but out of range value is caught by validation
      expect(errorsOf(() => mergeFlags(base(), { port: "70000" }))[0]).to.match(/^port: expected an integer/);
    });
  });
});

describe("config pin and tls", () => {
  it("accepts a valid pin and an endpoint with tls", () => {
    const hash = "a".repeat(64);
    const cfg = validateConfig({ pin: { neighbourhoodSha256: hash }, upstreams: [{ host: "h", port: 1, tls: true }] });
    expect(cfg.pin).to.deep.equal({ neighbourhoodSha256: hash });
    expect(cfg.upstreams[0]).to.deep.equal({ host: "h", port: 1, transport: "http", tls: true });
  });

  it("rejects a malformed pin, an unknown pin key and a non-boolean tls", () => {
    for (const bad of [
      { pin: { neighbourhoodSha256: "abc" } },
      { pin: { neighbourhoodSha256: "A".repeat(64) } },
      { pin: { other: 1 } },
      { upstreams: [{ host: "h", port: 1, tls: "yes" }] },
    ]) {
      expect(() => validateConfig(bad)).to.throw();
    }
  });
});
