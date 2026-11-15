import { expect } from "chai";
import "mocha";
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


/**
 * What hybrid verification promises that a mutation pass found nothing
 * checking: a node or a key is counted once, one malformed or unsigned vote
 * does not stop the rest being read, a malformed attestation is refused
 * rather than thrown on, and a malformed feed item says why.
 */
describe("hybrid verify - mutation gaps", () => {
  const keysFor = () => nodeKeys(setupDoc(), NETWORK);

  describe("nodeKeys", () => {
    it("skips a neighbour with no host, port or identity, and carries on with the rest", () => {
      const doc = setupDoc({
        neighbourhood: [
          { port: 1, identity: { type: "rsa", public: "x" } },
          { host: "h", identity: { type: "rsa", public: "x" } },
          { host: "h", port: 1 },
          { host: "h", port: 2, identity: { type: "rsa" } },
          null,
          { host: members[0].host, port: members[0].port, identity: { type: "rsa", public: members[0].public } },
        ],
      });
      const keys = nodeKeys(doc, NETWORK);
      expect([...keys.keys()]).to.deep.equal([members[0].ref]);
    });

    it("keeps the key type it is given and defaults to rsa", () => {
      const doc = setupDoc({
        neighbourhood: [
          { host: members[0].host, port: members[0].port, identity: { type: "secp256k1", public: members[0].public } },
          { host: members[1].host, port: members[1].port, identity: { public: members[1].public } },
        ],
      });
      const keys = nodeKeys(doc, NETWORK);
      expect(keys.get(members[0].ref)?.type).to.equal("secp256k1");
      expect(keys.get(members[1].ref)?.type).to.equal("rsa");
    });
  });

  describe("verifyVotes", () => {
    for (const [label, bad] of [
      ["unsigned (no sig)", (v: any) => ({ vote: v.vote })],
      ["unsigned (empty sig)", (v: any) => ({ vote: v.vote, sig: "" })],
      ["a sig that is not a string", (v: any) => ({ vote: v.vote, sig: 7 })],
      ["a forged signature", (v: any) => ({ vote: v.vote, sig: "AAAA" })],
      ["no vote", () => ({ sig: "x" })],
    ] as const) {
      it(`reads every other node's vote when one is ${label}, wherever it sorts`, () => {
        for (const broken of members) {
          const item: any = committed("u1", members.slice(0, 4));
          item.nodes[broken.ref] = (bad as any)(item.nodes[broken.ref]);
          const result = verifyVotes(item, keysFor());
          expect(result.valid.map((v) => v.ref).sort(), `${label} from ${broken.ref}`).to.deep.equal(
            members.filter((m) => m !== broken).map((m) => m.ref).sort()
          );
        }
      });
    }

    it("files an unsigned vote as ignored, not invalid", () => {
      const item: any = committed("u1", members.slice(0, 3));
      item.nodes[members[0].ref] = { vote: true };
      const result = verifyVotes(item, keysFor());
      expect(result.invalid).to.deep.equal([]);
      expect(result.ignored).to.deep.include({ ref: members[0].ref, reason: "unsigned" });
    });

    it("files a signature that is not a string as unsigned, not as invalid", () => {
      const item: any = committed("u1", members.slice(0, 3));
      item.nodes[members[0].ref] = { vote: true, sig: 7 };
      const result = verifyVotes(item, keysFor());
      expect(result.invalid).to.deep.equal([]);
      expect(result.ignored).to.deep.include({ ref: members[0].ref, reason: "unsigned" });
    });

    it("still reads the later nodes when an unknown node sorts before them", () => {
      for (const unknownRef of ["0".repeat(40), "f".repeat(40)]) {
        const item: any = committed("u1", members.slice(0, 4));
        item.nodes[unknownRef] = vote(members[0], "u1", true);
        const result = verifyVotes(item, keysFor());
        expect(result.ignored).to.deep.include({ ref: unknownRef, reason: "unknown node" });
        expect(result.valid.map((v) => v.ref).sort()).to.deep.equal(members.map((m) => m.ref).sort());
      }
    });

    it("still reads the later nodes after a vote whose key was already counted", () => {
      const keys = keysFor();
      const refs = members.map((m) => m.ref).sort();
      const byRef = (ref: string) => members.find((m) => m.ref === ref)!;
      // the second node in order shares the first's key, and signs with it
      keys.set(refs[1], keys.get(refs[0])!);
      const item: any = { umid: "u1", $revs: revs, nodes: {} };
      item.nodes[refs[0]] = vote(byRef(refs[0]), "u1", true);
      item.nodes[refs[1]] = vote(byRef(refs[0]), "u1", true);
      item.nodes[refs[2]] = vote(byRef(refs[2]), "u1", true);
      item.nodes[refs[3]] = vote(byRef(refs[3]), "u1", true);
      const result = verifyVotes(item, keys);
      expect(result.ignored).to.deep.include({ ref: refs[1], reason: "duplicate key" });
      expect(result.valid.map((v) => v.ref)).to.deep.equal([refs[0], refs[2], refs[3]]);
    });

    it("reads a nodes field that is not an object as no votes at all", () => {
      for (const nodesValue of ["abc", null, 5, undefined]) {
        const result = verifyVotes({ umid: "u1", $revs: revs, nodes: nodesValue } as any, keysFor());
        expect(result, String(nodesValue)).to.deep.equal({ valid: [], invalid: [], ignored: [] });
      }
    });
  });

  describe("verifyAttestation", () => {
    const good = () => attest(members[0], "u1");

    it("accepts the good one, so the refusals below mean something", () => {
      expect(verifyAttestation(good(), revs, keysFor())).to.equal(true);
    });

    for (const [label, mutate] of [
      ["undefined", () => undefined],
      ["null", () => null],
      ["a string", () => "att"],
      ["sig not a string", (a: any) => ({ ...a, sig: 5 })],
      ["node not a string", (a: any) => ({ ...a, node: 5 })],
      ["umid not a string", (a: any) => ({ ...a, umid: 5 })],
      ["umidDocHash not a string", (a: any) => ({ ...a, umidDocHash: 5 })],
      ["no revsOut", (a: any) => ({ ...a, revsOut: undefined })],
      ["revsOut a string", (a: any) => ({ ...a, revsOut: "x" })],
      ["revsOut null", (a: any) => ({ ...a, revsOut: null })],
      ["an unknown node", (a: any) => ({ ...a, node: "nobody" })],
    ] as const) {
      it(`refuses an attestation with ${label} without throwing`, () => {
        const att = (mutate as any)(good());
        expect(() => verifyAttestation(att, revs, keysFor())).to.not.throw();
        expect(verifyAttestation(att, revs, keysFor())).to.equal(false);
      });
    }
  });

  describe("quorum", () => {
    it("counts the same node's attestation once however often it is sent", () => {
      const a = attest(members[0], "u1");
      const q = quorum([a, a, a, a], revs, keysFor(), 60, 4);
      expect(q.count).to.equal(1);
      expect(q.reached).to.equal(false);
    });

    it("counts two node references that share one key once", () => {
      const shared = members[0];
      const other = "ref-of-a-second-node";
      const keys = keysFor();
      keys.set(other, { type: "rsa", public: shared.public });
      const q = quorum([attest(shared, "u1"), attest(shared, "u1", { node: other })], revs, keys, 60, 4);
      expect(q.count).to.equal(1);
    });

    it("carries on past an attestation that does not verify", () => {
      const bad = { ...attest(members[0], "u1"), sig: "AAAA" };
      const q = quorum([bad, attest(members[1], "u1"), attest(members[2], "u1")], revs, keysFor(), 50, 4);
      expect(q.count).to.equal(2);
      expect(q.reached).to.equal(true);
    });

    it("takes the larger of two disagreeing groups", () => {
      const other = { revsOut: { b: { rev: "9-q", sha256: "e".repeat(64) } } };
      const q = quorum(
        [attest(members[0], "u1", other), attest(members[1], "u1"), attest(members[2], "u1")],
        revs,
        keysFor(),
        50,
        4
      );
      expect(q.count).to.equal(2);
      expect(q.agreed.map((a) => a.node).sort()).to.deep.equal([members[1].ref, members[2].ref].sort());
    });

    it("keeps the first group when two are the same size", () => {
      const other = { revsOut: { b: { rev: "9-q", sha256: "e".repeat(64) } } };
      const q = quorum([attest(members[0], "u1"), attest(members[1], "u1", other)], revs, keysFor(), 25, 4);
      expect(q.count).to.equal(1);
      expect(q.agreed[0].node).to.equal(members[0].ref);
    });

    it("reads a list that is not an array as no attestations", () => {
      expect(quorum("x" as any, revs, keysFor(), 60, 4).count).to.equal(0);
    });
  });

  describe("verifyFeedItem - a malformed item says why and is not attested", () => {
    const check = (patch: any) => verifyFeedItem({ ...committed("u1"), ...patch }, verifyContext(setupDoc(), NETWORK));

    for (const [label, patch, reason] of [
      ["a umid that is not a string", { umid: 5 }, "missing umid"],
      ["an empty umid", { umid: "" }, "missing umid"],
      ["$revs that is not an object", { $revs: "x" }, "missing $revs"],
      ["missing $revs", { $revs: undefined }, "missing $revs"],
      ["nodes that is not an object", { nodes: "x" }, "missing nodes"],
      ["missing nodes", { nodes: undefined }, "missing nodes"],
    ] as const) {
      it(`rejects ${label}`, () => {
        const r = check(patch);
        expect(r.ok).to.equal(false);
        expect(r.reasons).to.include(reason);
        expect(r.attestationOk).to.equal(false);
      });
    }

    it("rejects something that is not an object, with no attestation", () => {
      for (const v of [null, undefined, "x", 3]) {
        const r = verifyFeedItem(v as any, verifyContext(setupDoc(), NETWORK));
        expect(r.ok).to.equal(false);
        expect(r.reasons).to.deep.equal(["not an object"]);
        expect(r.attestationOk).to.equal(false);
      }
    });
  });
});
