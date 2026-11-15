import { expect } from "chai";
import "mocha";
import { Processor } from "../packages/hybrid/src/processor";
import { ActiveCrypto } from "../packages/crypto/src";
import {
  docHash,
  nodeKeys,
  quorum,
  reaches,
  tally,
  verifyAttestation,
  verifyContext,
  verifyFeedItem,
  verifyUmidDoc,
  verifyVotes,
} from "../packages/hybrid/src/verify";

const NETWORK = "setup-stream-id";

// Five supernodes; the fifth is generated but left out of the setup stream
const nodes = Array.from({ length: 5 }, (_, i) => {
  const pair = new ActiveCrypto.KeyPair("rsa");
  const keys = pair.generate();
  const host = `10.0.0.${i + 1}`;
  const port = 5260;
  return {
    host,
    port,
    pair: new ActiveCrypto.KeyPair("rsa", keys.prv.pkcs8pem),
    public: keys.pub.pkcs8pem,
    ref: ActiveCrypto.Hash.getHash(host + port + NETWORK, "sha1"),
  };
});
const members = nodes.slice(0, 4);
const outsider = nodes[4];

const setupDoc = (over: any = {}) => ({
  _id: NETWORK,
  consensus: { reached: 60 },
  neighbourhood: members.map((n) => ({ host: n.host, port: n.port, identity: { type: "rsa", public: n.public } })),
  ...over,
});

const revs = { $i: { a: "1-x" }, $o: { b: "2-y" } };

const vote = (n: (typeof nodes)[number], umid: string, v: boolean, r: unknown = revs) => ({
  vote: v,
  sig: ActiveCrypto.signDigest(n.pair, ActiveCrypto.voteDigest(umid, v, r)),
});

const umidDocFor = (umid: string, r: unknown = revs) => ({
  _id: `${umid}:umid`,
  _rev: "1-abc",
  umid: { $umid: umid, $tx: { $contract: "c" }, $revs: r, $datetime: "2026-01-01T00:00:00.000Z" },
  streams: { new: [], updated: [] },
  events: [],
});

const revsOut = { b: { rev: "3-z", sha256: "f".repeat(64) } };

const attest = (n: (typeof nodes)[number], umid: string, over: any = {}) => {
  const a: any = {
    node: n.ref,
    umid,
    outcome: "committed",
    revsOut,
    umidDocHash: docHash(umidDocFor(umid)),
    ...over,
  };
  a.sig = ActiveCrypto.signDigest(
    n.pair,
    ActiveCrypto.commitDigest(a.umid, a.outcome, over.$signRevs ?? revs, a.revsOut, a.umidDocHash)
  );
  delete a.$signRevs;
  return a;
};

const committed = (umid = "u1", yesNodes = members.slice(0, 3), noNodes: typeof members = []): any => {
  const ns: any = {};
  for (const n of yesNodes) ns[n.ref] = vote(n, umid, true);
  for (const n of noNodes) ns[n.ref] = vote(n, umid, false);
  return {
    umid,
    outcome: "committed",
    umidDoc: umidDocFor(umid),
    $revs: revs,
    revsOut,
    streams: { new: [], updated: [] },
    nodes: ns,
    attestation: attest(members[0], umid),
  };
};


const verifyCtx = () => verifyContext(setupDoc(), NETWORK);

const makeProcessor = (sources: any) =>
  new Processor({
    store: { data: { get: async () => ({}), bulkDocs: async () => ({ ok: true }) }, events: { post: async () => ({ ok: true }) } } as any,
    sources,
    lookup: {} as any,
    events: { emit: async () => undefined },
    context: () => undefined,
    contracts: null,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  }) as any;

const attestingSource = (id: string, att: any, calls: string[] = []) => ({
  id,
  attest: async () => (calls.push(id), att),
});

describe("hybrid Processor.gatherQuorum - which attestations count for the item's claim", () => {
  const otherRevsOut = { b: { rev: "9-q", sha256: "e".repeat(64) } };
  const itemWith = (own: any, others: any[] = []): any => ({ umid: "u1", $revs: revs, attestation: own, attestations: others });

  it("reaches when enough nodes sign the same claim as the item", async () => {
    const own = attest(members[0], "u1");
    const item = itemWith(own, [attest(members[1], "u1"), attest(members[2], "u1")]);
    const q = await makeProcessor({ peers: [], supernodes: [] }).gatherQuorum(item, verifyCtx());
    expect(q).to.deep.equal({ reached: true, count: 3 });
  });

  it("does not count a quorum that agrees with itself but not with the item's revsOut", async () => {
    const own = attest(members[0], "u1");
    const item = itemWith(own, [1, 2, 3].map((i) => attest(members[i], "u1", { revsOut: otherRevsOut })));
    const q = await makeProcessor({ peers: [], supernodes: [] }).gatherQuorum(item, verifyCtx());
    expect(q).to.deep.equal({ reached: false, count: 0 });
  });

  it("does not count a quorum that agrees with itself but not with the item's umid document hash", async () => {
    const own = attest(members[0], "u1");
    const item = itemWith(own, [1, 2, 3].map((i) => attest(members[i], "u1", { umidDocHash: "d".repeat(64) })));
    const q = await makeProcessor({ peers: [], supernodes: [] }).gatherQuorum(item, verifyCtx());
    expect(q).to.deep.equal({ reached: false, count: 0 });
  });

  it("does not count attestations that say the transaction failed", async () => {
    const own = attest(members[0], "u1");
    const item = itemWith(own, [1, 2, 3].map((i) => attest(members[i], "u1", { outcome: "failed" })));
    const q = await makeProcessor({ peers: [], supernodes: [] }).gatherQuorum(item, verifyCtx());
    expect(q.reached).to.equal(false);
  });

  it("answers not reached, without throwing, when no attestation verifies", async () => {
    const forged = { ...attest(members[0], "u1"), sig: "AAAA" };
    const q = await makeProcessor({ peers: [], supernodes: [] }).gatherQuorum(itemWith(forged), verifyCtx());
    expect(q).to.deep.equal({ reached: false, count: 0 });
  });

  it("asks the supernodes until it reaches, skipping one that is down, and then stops asking", async () => {
    const own = attest(members[0], "u1");
    const calls: string[] = [];
    const down = { id: "down", attest: async () => (calls.push("down"), Promise.reject(new Error("offline"))) };
    const sources = {
      peers: [],
      supernodes: [down, attestingSource("s1", attest(members[1], "u1"), calls), attestingSource("s2", attest(members[2], "u1"), calls), attestingSource("s3", attest(members[3], "u1"), calls)],
    };
    const q = await makeProcessor(sources).gatherQuorum(itemWith(own), verifyCtx());
    expect(q).to.deep.equal({ reached: true, count: 3 });
    expect(calls, "s3 is not asked once three agree").to.deep.equal(["down", "s1", "s2"]);
  });
});

describe("hybrid Processor.spi - what a peer majority and a supernode majority may repair", () => {
  const doc = (id: string, rev: string, extra: any = {}) => ({ _id: id, _rev: rev, ...extra });
  const peerReturning = (id: string, docs: any[]) => ({ id, streams: async () => ({ docs }) });
  const ID = "s1";
  const good = doc(ID, "2-aaaa", { v: 1 });
  const revsOutFor = (d: any) => ({ [ID]: { rev: d._rev, sha256: docHash(d) } });

  it("takes what more than half of the peers agree on", async () => {
    const other = doc(ID, "2-aaaa", { v: 2 });
    const p = makeProcessor({ peers: [peerReturning("p1", [good]), peerReturning("p2", [good]), peerReturning("p3", [other])], supernodes: [] });
    const r = await p.spi(revsOutFor(good), false);
    expect(r.missing).to.deep.equal([]);
    expect(r.docs[ID]).to.deep.equal(good);
  });

  it("does not take a bare half of the peers", async () => {
    const other = doc(ID, "2-aaaa", { v: 2 });
    const p = makeProcessor({ peers: [peerReturning("p1", [good]), peerReturning("p2", [other])], supernodes: [] });
    const r = await p.spi(revsOutFor(good), false);
    expect(r.docs[ID]).to.equal(undefined);
    expect(r.missing).to.deep.equal([ID]);
  });

  it("takes a single matching peer when the outputs were signed by a quorum", async () => {
    const other = doc(ID, "2-aaaa", { v: 2 });
    const p = makeProcessor({ peers: [peerReturning("p1", [good]), peerReturning("p2", [other])], supernodes: [] });
    const r = await p.spi(revsOutFor(good), true);
    expect(r.docs[ID]).to.deep.equal(good);
  });

  describe("supernode majority by revision", () => {
    const supernodes = (d: any) => [1, 2, 3].map((i) => peerReturning(`sn${i}`, [d]));

    it("adopts a majority revision that is further on than the attested one", async () => {
      const ahead = doc(ID, "3-bbbb", { v: 9 });
      const r = await makeProcessor({ peers: [], supernodes: supernodes(ahead) }).spi(revsOutFor(good), false);
      expect(r.docs[ID]).to.deep.equal(ahead);
    });

    it("does not adopt a different revision at the same position, which is a fork", async () => {
      const fork = doc(ID, "2-bbbb", { v: 9 });
      const r = await makeProcessor({ peers: [], supernodes: supernodes(fork) }).spi(revsOutFor(good), false);
      expect(r.docs[ID]).to.equal(undefined);
      expect(r.missing).to.deep.equal([ID]);
    });

    it("does not adopt a majority revision that is behind the attested one", async () => {
      const behind = doc(ID, "1-cccc", { v: 0 });
      const r = await makeProcessor({ peers: [], supernodes: supernodes(behind) }).spi(revsOutFor(good), false);
      expect(r.docs[ID]).to.equal(undefined);
    });
  });
});
