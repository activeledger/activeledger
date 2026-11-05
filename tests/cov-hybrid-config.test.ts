import { expect } from "chai";
import "mocha";
import { ConfigError, defaultConfig, mergeFlags, parseUpstream, validateConfig } from "../packages/hybrid/src/config";

const errorsOf = (raw: unknown): string[] => {
  try {
    validateConfig(raw);
  } catch (e) {
    return (e as ConfigError).errors;
  }
  return [];
};

describe("Hybrid config validation, section shapes (cov)", () => {
  for (const [key, shape] of [
    ["window", "{days}"],
    ["events", "{contracts?, where?}"],
    ["submit", "{contracts?}"],
    ["pin", "{neighbourhoodSha256}"],
  ] as const) {
    it(`${key} must be an object, naming what it got`, () => {
      for (const [bad, said] of [[5, "number"], [null, "null"], [[1], "array"], ["x", "string"]] as const) {
        expect(errorsOf({ [key]: bad })).to.deep.equal([`${key}: expected an object ${shape}, got ${said}`]);
      }
    });
  }

  it("accepts the same sections when they are objects", () => {
    expect(errorsOf({ window: { days: 3 }, events: {}, submit: {}, pin: { neighbourhoodSha256: "a".repeat(64) } })).to.deep.equal([]);
  });

  it("reports an unknown key inside a section", () => {
    const errs = errorsOf({ window: { days: 3, bogus: 1 } });
    expect(errs.length).to.equal(1);
    expect(errs[0]).to.contain("bogus");
  });
});

describe("Hybrid parseUpstream (cov)", () => {
  const fails = (v: string) => {
    try {
      parseUpstream(v);
    } catch (e) {
      return (e as ConfigError).errors[0];
    }
    throw new Error("should have failed: " + v);
  };

  it("parses host:port with http by default", () => {
    expect(parseUpstream("a.example:80")).to.deep.equal({ host: "a.example", port: 80, transport: "http" });
  });
  it("parses a transport and a bracketed IPv6 address", () => {
    expect(parseUpstream("[::1]:5271:p2p")).to.deep.equal({ host: "::1", port: 5271, transport: "p2p" });
  });
  it("refuses extra parts after a bracketed address", () => {
    expect(fails("[::1]:80:p2p:x")).to.contain("too many parts").and.to.not.contain("IPv6");
  });
  it("tells an unbracketed IPv6 address to be bracketed", () => {
    expect(fails("::1:80:p2p")).to.contain("put an IPv6 address in brackets");
  });
  it("refuses bad ports and transports and other malformations", () => {
    expect(fails("h:0")).to.contain("port");
    expect(fails("h:65536")).to.contain("port");
    expect(fails("h:80:ftp")).to.contain("transport");
    expect(fails("h")).to.contain("missing port");
    expect(fails(":80")).to.contain("missing host");
    expect(fails("[::1")).to.contain("unclosed");
    expect(fails("[]:80")).to.contain("empty IPv6");
    expect(fails("[::1]80")).to.contain("missing port");
    expect(fails("")).to.contain("empty");
  });
});

describe("Hybrid mergeFlags, upstream and peer flags (cov)", () => {
  it("replaces the configured peers with the flagged ones", () => {
    const cfg = { ...defaultConfig(), peers: [{ host: "old", port: 1, transport: "http" as const }] };
    const out = mergeFlags(cfg, { peer: ["p1:5271:p2p", "p2:80"] });
    expect(out.peers).to.deep.equal([
      { host: "p1", port: 5271, transport: "p2p" },
      { host: "p2", port: 80, transport: "http" },
    ]);
  });
  it("reports an invalid --peer by flag name, and --upstream likewise", () => {
    let err: ConfigError | undefined;
    try {
      mergeFlags(defaultConfig(), { peer: ["nope"], upstream: ["alsonope"] });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).to.be.instanceOf(ConfigError);
    expect(err!.errors.length).to.equal(2);
    expect(err!.errors.some((m) => m.startsWith("--peer: ") && m.includes("nope"))).to.equal(true);
    expect(err!.errors.some((m) => m.startsWith("--upstream: "))).to.equal(true);
  });
});
