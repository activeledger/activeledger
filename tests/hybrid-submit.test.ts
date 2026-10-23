import { expect } from "chai";
import "mocha";
// By package name: endpoints reads build through the built lib's ActiveOptions
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "../packages/crypto/src";
import { Endpoints } from "../packages/network/src/network/endpoints";
import {
  Submitter,
  SubmitterOptions,
  classifyFailure,
  computeUmid,
  refusal,
} from "../packages/hybrid/src/submit";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";

const kp = new ActiveCrypto.KeyPair("secp256k1");
const pem = kp.generate(2048, true).pub.pkcs8pem;

const future = () => new Date(Date.now() + 60000).toISOString();

const tx = (over: any = {}) => ({
  $tx: {
    $namespace: "test",
    $contract: "c",
    $i: { s1: { x: 1 } },
    $o: { s2: {} },
    $expire: future(),
    ...over,
  },
  $sigs: { s1: "sig" },
});

const yes = (over: any = {}) => ({
  umid: "",
  vote: true,
  committed: true,
  documents: {},
  volatile: {},
  events: [],
  supernodeDependent: false,
  dependence: [],
  adopt: [],
  ...over,
});

/** An upstream that records what it got and answers as told */
const upstream = (answer: (tx: any) => Promise<any>, id = "sn") => {
  const got: any[] = [];
  return {
    id,
    got,
    submit: (t: any) => {
      got.push(JSON.parse(JSON.stringify(t)));
      return answer(t);
    },
  } as any;
};

describe("Hybrid POST /: refusal (step 0)", () => {
  const cfg = { refuseOnboard: true };

  for (const c of ["contract", "namespace", "setup", "fund"]) {
    it(`denies default/${c}, whatever the config`, () => {
      expect(refusal(tx({ $namespace: "default", $contract: c }), { refuseOnboard: false })).to.be.a("string");
    });
  }

  it("is not fooled by case, whitespace or a version suffix", () => {
    expect(refusal(tx({ $namespace: "Default", $contract: "Contract" }), cfg)).to.be.a("string");
    expect(refusal(tx({ $namespace: " default ", $contract: "setup " }), cfg)).to.be.a("string");
    expect(refusal(tx({ $namespace: "default", $contract: "fund@1" }), cfg)).to.be.a("string");
  });

  it("denies default/onboard while refuseOnboard, allows it when false", () => {
    const t = tx({ $namespace: "default", $contract: "onboard" });
    expect(refusal(t, { refuseOnboard: true })).to.be.a("string");
    expect(refusal(t, {} as any)).to.be.a("string");
    expect(refusal(t, { refuseOnboard: false })).to.equal(undefined);
  });

  it("allows other default contracts and other namespaces", () => {
    expect(refusal(tx({ $namespace: "default", $contract: "hybrid" }), cfg)).to.equal(undefined);
    expect(refusal(tx({ $namespace: "mine", $contract: "contract" }), cfg)).to.equal(undefined);
  });

  it("denies a transaction without $expire (or a falsy one)", () => {
    for (const e of [undefined, "", 0, null]) {
      expect(refusal(tx({ $expire: e }), cfg), String(e)).to.match(/\$expire/);
    }
  });

  it("denies a contract not in submit.contracts", () => {
    const c = { refuseOnboard: true, submit: { contracts: ["c", "d"] } };
    expect(refusal(tx(), c)).to.equal(undefined);
    expect(refusal(tx({ $contract: "c@2.0.0" }), c)).to.equal(undefined);
    expect(refusal(tx({ $contract: "e" }), c)).to.match(/not accepted/);
    expect(refusal(tx(), { refuseOnboard: true, submit: { contracts: [] } })).to.match(/not accepted/);
  });

  it("denies non-transactions and missing or non-string $namespace/$contract", () => {
    expect(refusal(null, cfg)).to.be.a("string");
    expect(refusal([], cfg)).to.be.a("string");
    expect(refusal({ $tx: "x" }, cfg)).to.be.a("string");
    expect(refusal(tx({ $namespace: undefined }), cfg)).to.be.a("string");
    expect(refusal(tx({ $contract: ["contract"] }), cfg)).to.be.a("string");
  });
});

describe("Hybrid POST /: Submitter", () => {
  let state: any;
  let refreshed: string[][];
  let dryRuns: any[];
  let vote: any;

  const make = (over: Partial<SubmitterOptions> = {}, supernodes: any[] = [], peers: any[] = []) =>
    new Submitter({
      config: { refuseOnboard: true },
      state,
      sources: { supernodes, peers },
      lookup: {
        ensure: async () => ({ missing: [] }),
        refreshToTip: async (ids) => {
          refreshed.push(ids);
          return { missing: [] };
        },
      },
      identity: { pair: kp, publicPem: pem },
      dryRun: async (entry) => {
        dryRuns.push(entry);
        return typeof vote === "function" ? vote(entry) : vote;
      },
      ...over,
    });

  beforeEach(() => {
    state = { version: "5.1.0", ready: true, cursor: "", headConfirmedAt: Date.now(), upstreams: [] };
    refreshed = [];
    dryRuns = [];
    vote = yes();
  });

  it("denied: answers $hybrid denied and does nothing else", async () => {
    const sn = upstream(async () => ({}));
    const r = await make({}, [sn]).submit(tx({ $namespace: "default", $contract: "setup" }));
    expect(r.status).to.equal(403);
    expect(r.body.$hybrid).to.equal("denied");
    expect(dryRuns).to.have.length(0);
    expect(refreshed).to.have.length(0);
    expect(sn.got).to.have.length(0);
  });

  it("unavailable while not ready or outdated", async () => {
    const sn = upstream(async () => ({}));
    state.ready = false;
    state.reason = "outdated";
    let r = await make({}, [sn]).submit(tx());
    expect(r.body).to.include({ $hybrid: "unavailable" });
    expect(r.status).to.equal(503);
    state.reason = "starting";
    r = await make({}, [sn]).submit(tx());
    expect(r.body.$hybrid).to.equal("unavailable");
    expect(sn.got).to.have.length(0);
  });

  it("refused: an expired $expire, an invalid one, missing $sigs", async () => {
    const sn = upstream(async () => ({}));
    const s = make({}, [sn]);
    let r = await s.submit(tx({ $expire: new Date(Date.now() - 1000).toISOString() }));
    expect(r.body.$hybrid).to.equal("refused");
    expect(r.body.error).to.match(/Transaction Expired/);
    r = await s.submit(tx({ $expire: "not a date" }));
    expect(r.body.$hybrid).to.equal("refused");
    const noSigs: any = tx();
    delete noSigs.$sigs;
    r = await s.submit(noSigs);
    expect(r.body.$hybrid).to.equal("refused");
    expect(sn.got).to.have.length(0);
    expect(dryRuns).to.have.length(0);
  });

  it("refreshes the $i, $o and $r streams to their tips before voting", async () => {
    const sn = upstream(async () => ({ ok: 1 }));
    await make({}, [sn]).submit(tx({ $r: { s3: {} } }));
    expect(refreshed).to.deep.equal([["s1", "s2", "s3"]]);
    expect(dryRuns).to.have.length(1);
  });

  it("still votes when the refresh fails (the copy may be stale)", async () => {
    const sn = upstream(async () => ({ ok: 1 }));
    const s = make(
      {
        lookup: {
          ensure: async () => ({ missing: [] }),
          refreshToTip: async () => {
            throw new Error("down");
          },
        },
      },
      [sn]
    );
    const r = await s.submit(tx());
    expect(r.body).to.deep.equal({ ok: 1 });
  });

  it("dry-runs a copy with $umid and the hybrid's clock as $datetime, without $relay", async () => {
    const sn = upstream(async () => ({}));
    const t: any = tx();
    t.$relay = { key: "someone", sig: "else" };
    await make({ now: () => 1234 }, [sn]).submit(t);
    const e = dryRuns[0];
    expect(e.$umid).to.equal(computeUmid(t));
    expect(new Date(e.$datetime).getTime()).to.equal(1234);
    expect(e.$relay).to.equal(undefined);
  });

  it("refused: a local no returns the contract's error and forwards nothing", async () => {
    const sn = upstream(async () => ({}));
    vote = yes({ vote: false, committed: false, error: "Insufficient funds" });
    const r = await make({}, [sn]).submit(tx());
    expect(r.status).to.equal(422);
    expect(r.body).to.deep.equal({ $hybrid: "refused", error: "Insufficient funds" });
    expect(sn.got).to.have.length(0);
  });

  it("refused: a vote that passed but whose commit failed", async () => {
    const sn = upstream(async () => ({}));
    vote = yes({ committed: false, error: "commit broke" });
    const r = await make({}, [sn]).submit(tx());
    expect(r.body).to.deep.equal({ $hybrid: "refused", error: "commit broke" });
  });

  it("refused: a dry run that throws", async () => {
    const sn = upstream(async () => ({}));
    vote = () => Promise.reject(new Error("Contract not found"));
    const r = await make({}, [sn]).submit(tx());
    expect(r.body).to.deep.equal({ $hybrid: "refused", error: "Contract not found" });
  });

  it("conditional yes: a supernode-dependent execution is forwarded", async () => {
    const sn = upstream(async () => ({ $umid: "x" }));
    vote = yes({ vote: false, committed: false, error: "SupernodeOnly", supernodeDependent: true });
    const r = await make({}, [sn]).submit(tx());
    expect(sn.got).to.have.length(1);
    expect(r.body).to.deep.equal({ $umid: "x" });
  });

  it("yes: attaches $relay {key, sig over $umid} and returns the answer unchanged", async () => {
    const answer = { $umid: "abc", $summary: { total: 1, vote: 1, commit: 1 }, $streams: { new: [], updated: [] } };
    const sn = upstream(async () => answer);
    const t = tx();
    const r = await make({}, [sn]).submit(JSON.parse(JSON.stringify(t)));
    expect(r.status).to.equal(200);
    expect(r.body).to.equal(answer);
    expect(JSON.stringify(r.body)).to.equal(JSON.stringify(answer));
    expect("$hybrid" in r.body).to.equal(false);

    const sent = sn.got[0];
    const umid = computeUmid(t);
    expect(sent.$relay.key).to.equal(pem);
    expect(ActiveCrypto.verifyDigest(pem, "secp256k1", umid, sent.$relay.sig)).to.equal(true);
    // Nothing else added or changed
    const { $relay, ...rest } = sent;
    expect(rest).to.deep.equal(t);
  });

  it("replaces a client-supplied $relay with its own", async () => {
    const sn = upstream(async () => ({}));
    const t: any = tx();
    t.$relay = { key: "forged", sig: "forged" };
    await make({}, [sn]).submit(t);
    expect(sn.got[0].$relay.key).to.equal(pem);
  });

  it("passes a supernode's error status and body through unchanged", async () => {
    const body = { status: 500, error: "Internal Server Error" };
    const sn = upstream(async () => {
      throw new UpstreamError("POST /: 500", "http", 500, body);
    });
    const r = await make({}, [sn]).submit(tx());
    expect(r).to.deep.equal({ status: 500, body });
  });

  it("tries the next supernode when one cannot be reached", async () => {
    const down = upstream(async () => {
      throw new UpstreamError("sn1 POST /: ECONNREFUSED", "network");
    }, "sn1");
    const up = upstream(async () => ({ ok: true }), "sn2");
    const r = await make({}, [down, up]).submit(tx());
    expect(r.body).to.deep.equal({ ok: true });
    expect(down.got).to.have.length(1);
    expect(up.got).to.have.length(1);
    expect(up.got[0]).to.deep.equal(down.got[0]);
  });

  it("forwards through a peer when no supernode is reachable, with its own $relay", async () => {
    const down = upstream(async () => {
      throw new UpstreamError("sn POST /: ENOTFOUND", "network");
    });
    const peer = upstream(async () => ({ via: "peer" }), "peer");
    const r = await make({}, [down], [peer]).submit(tx());
    expect(r.body).to.deep.equal({ via: "peer" });
    expect(peer.got[0].$relay.key).to.equal(pem);
  });

  it("unavailable: nothing reachable", async () => {
    const down = () =>
      upstream(async () => {
        const e: any = new Error("connect ECONNREFUSED");
        e.code = "ECONNREFUSED";
        throw e;
      });
    const r = await make({}, [down()], [down()]).submit(tx());
    expect(r.status).to.equal(503);
    expect(r.body.$hybrid).to.equal("unavailable");
  });

  it("unavailable: no upstreams at all", async () => {
    const r = await make({}, [], []).submit(tx());
    expect(r.body.$hybrid).to.equal("unavailable");
  });

  it("unanswered: no answer in time, carries $umid, and is never retried", async () => {
    const slow = upstream(() => new Promise(() => undefined), "slow");
    const next = upstream(async () => ({}), "next");
    const t = tx();
    const r = await make({ answerTimeoutMs: 20 }, [slow, next]).submit(t);
    expect(r.status).to.equal(504);
    expect(r.body.$hybrid).to.equal("unanswered");
    expect(r.body.$umid).to.equal(computeUmid(t));
    expect(next.got).to.have.length(0);
  });

  it("unanswered: an upstream timeout or a reset after sending is not retried", async () => {
    for (const err of [
      new UpstreamError("POST /: timed out", "timeout"),
      new UpstreamError("POST /: ECONNRESET", "network"),
      new UpstreamError("POST /: 502", "http", 502, "Bad Gateway"),
    ]) {
      const bad = upstream(async () => {
        throw err;
      });
      const next = upstream(async () => ({}));
      const r = await make({}, [bad, next]).submit(tx());
      expect(r.body.$hybrid, err.message).to.equal("unanswered");
      expect(next.got).to.have.length(0);
    }
  });

  it("classifyFailure", () => {
    expect(classifyFailure(new UpstreamError("x: 404", "http", 404, undefined)).kind).to.equal("undelivered");
    expect(classifyFailure(new UpstreamError("x: 400", "http", 400, { error: "bad" }))).to.deep.equal({
      kind: "answered",
      status: 400,
      body: { error: "bad" },
    });
    expect(classifyFailure({ undelivered: true }).kind).to.equal("undelivered");
    expect(classifyFailure(new Error("something")).kind).to.equal("unanswered");
  });

  it("needs a db or a dryRun", () => {
    expect(() => make({ dryRun: undefined })).to.throw(/db or dryRun/);
  });
});

// The hybrid signs $umid into $relay before forwarding, so its computation
// must be exactly the entry supernode's. Run the real ExternalInitalise on
// what the hybrid forwarded.
describe("Hybrid POST /: $umid equals the entry supernode's", () => {
  const registryId = ActiveCrypto.hybridStreamId(pem);
  const originUmid = "e".repeat(64);
  const docs: { [id: string]: any } = {
    [registryId]: { _id: registryId, key: pem, keyType: "secp256k1", endpoints: [] },
    [`${registryId}:stream`]: { _id: `${registryId}:stream`, origin: originUmid },
    [`${originUmid}:umid`]: { umid: { $tx: { $namespace: "default", $contract: "hybrid" } } },
  };
  const db: any = {
    exists: async (id: string) => !!docs[id],
    get: async (id: string) => {
      if (!docs[id]) throw new Error("not found");
      return docs[id];
    },
  };
  let captured: any;
  let originalDirect: any;
  let originalBuild: any;

  beforeEach(() => {
    captured = undefined;
    originalBuild = ActiveOptions.get("build", 0);
    ActiveOptions.set("build", 40300);
    originalDirect = Endpoints.DirectInternalInitalise;
    (Endpoints as any).DirectInternalInitalise = (_host: any, t: any) => {
      captured = t;
      return new Promise(() => undefined);
    };
  });

  afterEach(() => {
    (Endpoints as any).DirectInternalInitalise = originalDirect;
    ActiveOptions.set("build", originalBuild);
  });

  const entry = async (body: any) => {
    Endpoints.ExternalInitalise({ reference: "entry" } as any, body, "1.2.3.4", db);
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setImmediate(r));
    expect(captured, "reached consensus").to.not.equal(undefined);
    return captured;
  };

  const viaHybrid = async (raw: string) => {
    let wire = "";
    const sn = {
      id: "sn",
      // The supernode receives the JSON text the hybrid sends
      submit: async (t: any) => {
        wire = JSON.stringify(t);
        return {};
      },
    } as any;
    const s = new Submitter({
      config: { refuseOnboard: true },
      state: { version: "5.1.0", ready: true, cursor: "", headConfirmedAt: 0, upstreams: [] },
      sources: { supernodes: [sn], peers: [] },
      lookup: { ensure: async () => ({ missing: [] }), refreshToTip: async () => ({ missing: [] }) },
      identity: { pair: kp, publicPem: pem },
      dryRun: async () => yes(),
    });
    await s.submit(JSON.parse(raw));
    return wire;
  };

  it("with key order, unicode and numbers as the client sent them", async () => {
    const raw = JSON.stringify({
      $sigs: { s1: "sig" },
      $tx: {
        $expire: future(),
        $contract: "c",
        $namespace: "test",
        $i: { s1: { amount: 1.5, big: 1e21, name: "é中", nested: { z: 1, a: [3, 2, 1] } } },
      },
      $selfsign: false,
    });
    const wire = await viaHybrid(raw);
    const forwarded = JSON.parse(wire);
    const umid = computeUmid(JSON.parse(raw));

    const got = await entry(JSON.parse(wire));
    expect(got.$umid).to.equal(umid);
    // ...and the entry supernode verified and kept the hybrid's $relay
    expect(got.$relay).to.deep.equal(forwarded.$relay);

    // The same transaction sent straight to a supernode gets the same umid
    captured = undefined;
    const direct = await entry(JSON.parse(raw));
    expect(direct.$umid).to.equal(umid);
  });

  it("when the client put its own $relay in the body", async () => {
    const body: any = tx();
    body.$relay = { key: "x", sig: "y" };
    const wire = await viaHybrid(JSON.stringify(body));
    const got = await entry(JSON.parse(wire));
    expect(got.$umid).to.equal(computeUmid(body));
    expect(got.$relay.key).to.equal(pem);
  });
});
