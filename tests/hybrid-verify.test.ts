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

describe("hybrid verify", () => {
  const ctx = () => verifyContext(setupDoc(), NETWORK);

  describe("nodeKeys", () => {
    it("derives each reference as sha1(host + port + network)", () => {
      const keys = nodeKeys(setupDoc(), NETWORK);
      expect([...keys.keys()]).to.deep.equal(members.map((n) => n.ref));
      expect(keys.get(members[0].ref)).to.deep.equal({ type: "rsa", public: members[0].public });
    });

    it("depends on the network string", () => {
      const keys = nodeKeys(setupDoc(), "other");
      expect(keys.has(members[0].ref)).to.equal(false);
    });

    it("honours neighbourhoodRemap", () => {
      const keys = nodeKeys(setupDoc({ neighbourhoodRemap: { [members[1].ref]: "remapped" } }), NETWORK);
      expect(keys.has(members[1].ref)).to.equal(false);
      expect(keys.get("remapped")!.public).to.equal(members[1].public);
    });

    it("skips malformed entries and tolerates a missing neighbourhood", () => {
      const doc = setupDoc();
      doc.neighbourhood.push({ host: "x", port: 1 } as any, null as any);
      expect(nodeKeys(doc, NETWORK).size).to.equal(4);
      expect(nodeKeys({}, NETWORK).size).to.equal(0);
      expect(nodeKeys(undefined, NETWORK).size).to.equal(0);
    });

    it("builds a context with the percent and the neighbourhood length", () => {
      const c = ctx();
      expect(c.reachedPercent).to.equal(60);
      expect(c.networkSize).to.equal(4);
    });
  });

  describe("verifyVotes", () => {
    it("counts signed votes from known nodes", () => {
      const r = verifyVotes(committed("u1", members.slice(0, 2), [members[2]]), ctx().keys);
      expect(r.valid).to.have.length(3);
      expect(r.invalid).to.deep.equal([]);
    });

    it("rejects a forged signature", () => {
      const item = committed();
      item.nodes[members[1].ref].sig = vote(outsider, "u1", true).sig;
      const r = verifyVotes(item, ctx().keys);
      expect(r.invalid).to.deep.equal([members[1].ref]);
      expect(r.valid).to.have.length(2);
    });

    it("rejects a vote signed over different revs", () => {
      const item = committed();
      item.nodes[members[0].ref] = vote(members[0], "u1", true, { $i: { a: "0-old" }, $o: { b: "2-y" } });
      expect(verifyVotes(item, ctx().keys).invalid).to.deep.equal([members[0].ref]);
    });

    it("rejects a vote replayed from another umid", () => {
      const item = committed();
      item.nodes[members[0].ref] = vote(members[0], "other-umid", true);
      expect(verifyVotes(item, ctx().keys).invalid).to.deep.equal([members[0].ref]);
    });

    it("rejects a no vote relabelled as yes", () => {
      const item = committed();
      item.nodes[members[3].ref] = { ...vote(members[3], "u1", false), vote: true };
      expect(verifyVotes(item, ctx().keys).invalid).to.deep.equal([members[3].ref]);
    });

    it("ignores unsigned votes, unknown references and votes without a boolean", () => {
      const item = committed("u1", members.slice(0, 1));
      item.nodes[members[1].ref] = { vote: true };
      item.nodes[outsider.ref] = vote(outsider, "u1", true);
      item.nodes[members[2].ref] = { vote: "yes", sig: "x" };
      const r = verifyVotes(item, ctx().keys);
      expect(r.valid.map((v) => v.ref)).to.deep.equal([members[0].ref]);
      expect(r.invalid).to.deep.equal([]);
      expect(r.ignored.map((i) => i.reason).sort()).to.deep.equal(["no vote", "unknown node", "unsigned"]);
    });

    it("counts one key once even under two references", () => {
      // The same identity listed twice in the setup stream
      const doc = setupDoc();
      doc.neighbourhood.push({ host: "dup", port: 1, identity: { type: "rsa", public: members[0].public } });
      const keys = nodeKeys(doc, NETWORK);
      const dupRef = ActiveCrypto.Hash.getHash("dup" + 1 + NETWORK, "sha1");
      const item = committed("u1", [members[0]]);
      item.nodes[dupRef] = vote(members[0], "u1", true);
      const r = verifyVotes(item, keys);
      expect(r.valid).to.have.length(1);
      expect(r.ignored).to.deep.equal([{ ref: [dupRef, members[0].ref].sort()[1], reason: "duplicate key" }]);
    });
  });

  describe("tally and percent", () => {
    it("is yes / networkSize * 100 >= reached", () => {
      expect(reaches(3, 75, 4)).to.equal(true);
      expect(reaches(2, 75, 4)).to.equal(false);
      expect(reaches(2, 50, 4)).to.equal(true);
      expect(reaches(4, 100, 4)).to.equal(true);
      expect(reaches(3, 100, 4)).to.equal(false);
      expect(reaches(2, 66.67, 3)).to.equal(false);
      expect(reaches(2, 66, 3)).to.equal(true);
      expect(reaches(1, 33.333333333333336, 3)).to.equal(false);
      expect(reaches(1, 33.33333333333333, 3)).to.equal(true);
    });

    it("never reaches without a yes, a network or a usable percent", () => {
      expect(reaches(0, 0, 4)).to.equal(false);
      expect(reaches(1, 0, 4)).to.equal(true);
      expect(reaches(4, 101, 4)).to.equal(false);
      expect(reaches(1, 10, 0)).to.equal(false);
      expect(reaches(1, NaN, 4)).to.equal(false);
      expect(reaches(1, undefined as any, 4)).to.equal(false);
    });

    it("tallies only valid signed votes", () => {
      const item = committed("u1", members.slice(0, 2), [members[2]]);
      item.nodes[members[3].ref] = { vote: true };
      expect(tally(item, ctx().keys, 60, 4)).to.deep.equal({ yes: 2, no: 1, reached: false });
      expect(tally(item, ctx().keys, 50, 4)).to.deep.equal({ yes: 2, no: 1, reached: true });
    });
  });

  describe("attestations", () => {
    it("verifies a commit attestation against the item's $revs", () => {
      const keys = ctx().keys;
      expect(verifyAttestation(attest(members[0], "u1"), revs, keys)).to.equal(true);
      expect(verifyAttestation(attest(members[0], "u1"), { $i: {}, $o: {} }, keys)).to.equal(false);
    });

    it("rejects a tampered field, an unknown node and a missing attestation", () => {
      const keys = ctx().keys;
      for (const over of [{ revsOut: { b: { rev: "4-z", sha256: "0" } } }, { umidDocHash: "0" }, { outcome: "failed" }, { umid: "u2" }]) {
        expect(verifyAttestation({ ...attest(members[0], "u1"), ...over }, revs, keys)).to.equal(false);
      }
      expect(verifyAttestation({ ...attest(members[0], "u1"), node: members[1].ref }, revs, keys)).to.equal(false);
      expect(verifyAttestation(attest(outsider, "u1"), revs, keys)).to.equal(false);
      expect(verifyAttestation(undefined, revs, keys)).to.equal(false);
      expect(verifyAttestation({ node: members[0].ref } as any, revs, keys)).to.equal(false);
    });

    it("checks the umid doc hash", () => {
      const item = committed();
      expect(verifyUmidDoc(item)).to.equal(true);
      item.umidDoc.umid.$tx.$contract = "evil";
      expect(verifyUmidDoc(item)).to.equal(false);
      expect(verifyUmidDoc({ ...committed(), umidDoc: undefined })).to.equal(false);
      expect(verifyUmidDoc({ ...committed(), attestation: undefined })).to.equal(false);
    });

    it("hashes canonically, so key order does not matter", () => {
      const doc = umidDocFor("u1");
      const reordered = JSON.parse(JSON.stringify({ events: doc.events, streams: doc.streams, umid: doc.umid, _rev: doc._rev, _id: doc._id }));
      expect(docHash(reordered)).to.equal(docHash(doc));
    });

    describe("quorum", () => {
      const keys = () => ctx().keys;
      it("counts distinct valid nodes that agree", () => {
        const atts = members.slice(0, 3).map((n) => attest(n, "u1"));
        expect(quorum(atts, revs, keys(), 60, 4)).to.include({ reached: true, count: 3 });
        expect(quorum(atts.slice(0, 2), revs, keys(), 60, 4)).to.include({ reached: false, count: 2 });
      });

      it("counts a node once however often it is sent", () => {
        const a = attest(members[0], "u1");
        expect(quorum([a, a, { ...a }, attest(members[1], "u1")], revs, keys(), 60, 4).count).to.equal(2);
      });

      it("drops invalid and unknown attestations", () => {
        const atts = [
          attest(members[0], "u1"),
          attest(members[1], "u1"),
          { ...attest(members[2], "u1"), sig: attest(members[3], "u1").sig },
          attest(outsider, "u1"),
        ];
        expect(quorum(atts, revs, keys(), 60, 4).count).to.equal(2);
      });

      it("needs identical claims, and returns the largest group", () => {
        const other = { b: { rev: "3-q", sha256: "e".repeat(64) } };
        const atts = [
          attest(members[0], "u1"),
          attest(members[1], "u1", { revsOut: other }),
          attest(members[2], "u1", { revsOut: other }),
          attest(members[3], "u1", { umidDocHash: "1".repeat(64) }),
        ];
        const q = quorum(atts, revs, keys(), 50, 4);
        expect(q).to.include({ reached: true, count: 2 });
        expect(q.agreed.map((a) => a.node)).to.deep.equal([members[1].ref, members[2].ref]);
        expect(quorum(atts, revs, keys(), 60, 4).reached).to.equal(false);
      });

      it("does not mix attestations for different umids", () => {
        const atts = [attest(members[0], "u1"), attest(members[1], "u2"), attest(members[2], "u3")];
        expect(quorum(atts, revs, keys(), 25, 4)).to.include({ count: 1, reached: true });
        expect(quorum(atts, revs, keys(), 50, 4).reached).to.equal(false);
      });

      it("handles nothing", () => {
        expect(quorum([], revs, keys(), 50, 4)).to.deep.equal({ reached: false, count: 0, agreed: [] });
        expect(quorum(undefined as any, revs, keys(), 50, 4).count).to.equal(0);
      });
    });
  });

  describe("verifyFeedItem", () => {
    it("accepts a committed item with consensus and a valid attestation", () => {
      const r = verifyFeedItem(committed(), ctx());
      expect(r).to.deep.equal({ ok: true, reasons: [], yes: 3, no: 0, attestationOk: true });
    });

    it("refuses a committed item below consensus", () => {
      const r = verifyFeedItem(committed("u1", members.slice(0, 2), members.slice(2)), ctx());
      expect(r.ok).to.equal(false);
      expect(r.reasons).to.deep.equal(["tally 2/4 below consensus 60%"]);
      expect(r).to.include({ yes: 2, no: 2, attestationOk: true });
    });

    it("does not let unsigned or unknown yes votes make up consensus", () => {
      const item = committed("u1", members.slice(0, 2));
      item.nodes[members[2].ref] = { vote: true };
      item.nodes[outsider.ref] = vote(outsider, "u1", true);
      item.nodes["made-up"] = { vote: true, sig: "x" };
      const r = verifyFeedItem(item, ctx());
      expect(r.ok).to.equal(false);
      expect(r.yes).to.equal(2);
    });

    it("refuses any forged vote even when consensus holds without it", () => {
      const item = committed("u1", members.slice(0, 3));
      item.nodes[members[3].ref] = vote(members[3], "replayed", true);
      const r = verifyFeedItem(item, ctx());
      expect(r.ok).to.equal(false);
      expect(r.reasons).to.deep.equal([`invalid vote signature from ${members[3].ref}`]);
    });

    it("refuses a committed item without a usable attestation", () => {
      const cases: [(i: any) => void, RegExp][] = [
        [(i) => delete i.attestation, /missing attestation/],
        [(i) => (i.attestation = attest(members[0], "u2")), /another umid/],
        [(i) => (i.attestation = { ...i.attestation, outcome: "failed" }), /not committed/],
        [(i) => (i.revsOut = { b: { rev: "9-z", sha256: "0" } }), /revsOut differs/],
        [(i) => (i.attestation = { ...i.attestation, sig: attest(members[1], "u1").sig }), /invalid attestation signature/],
        [(i) => (i.attestation = attest(outsider, "u1")), /invalid attestation signature/],
        [(i) => (i.umidDoc.events = [{ injected: true }]), /umidDocHash/],
      ];
      for (const [mutate, re] of cases) {
        const item = committed();
        mutate(item);
        const r = verifyFeedItem(item, ctx());
        expect(r.ok, String(re)).to.equal(false);
        expect(r.attestationOk).to.equal(false);
        expect(r.reasons.join(";")).to.match(re);
      }
    });

    it("refuses an item whose $revs were swapped after signing", () => {
      const item = committed();
      item.$revs = { $i: { a: "9-new" }, $o: { b: "2-y" } };
      const r = verifyFeedItem(item, ctx());
      expect(r.ok).to.equal(false);
      expect(r.yes).to.equal(0);
      expect(r.attestationOk).to.equal(false);
    });

    it("refuses a umid doc whose $revs differ from the signed ones", () => {
      // Signed consistently, but the stored doc names other revisions
      const other = { $i: {}, $o: {} };
      const item = committed();
      item.umidDoc = umidDocFor("u1", other);
      item.attestation = attest(members[0], "u1", { umidDocHash: docHash(item.umidDoc) });
      const r = verifyFeedItem(item, ctx());
      expect(r.reasons).to.deep.equal(["umid doc $revs differ from the item's"]);
    });

    it("accepts a failed item with valid votes and no consensus or attestation", () => {
      const item: any = {
        umid: "f1",
        outcome: "failed",
        tx: { $tx: {} },
        $revs: revs,
        nodes: { [members[0].ref]: vote(members[0], "f1", true), [members[1].ref]: vote(members[1], "f1", false) },
      };
      expect(verifyFeedItem(item, ctx())).to.deep.equal({ ok: true, reasons: [], yes: 1, no: 1, attestationOk: false });
    });

    it("refuses a failed item with a forged vote or no valid signed vote", () => {
      const forged: any = {
        umid: "f1",
        outcome: "failed",
        $revs: revs,
        nodes: { [members[0].ref]: vote(members[0], "f1", true), [members[1].ref]: vote(members[2], "f1", true) },
      };
      expect(verifyFeedItem(forged, ctx()).reasons).to.deep.equal([`invalid vote signature from ${members[1].ref}`]);
      const unsigned: any = { umid: "f1", outcome: "failed", $revs: revs, nodes: { [members[0].ref]: { vote: true } } };
      expect(verifyFeedItem(unsigned, ctx()).reasons).to.deep.equal(["no valid signed vote"]);
    });

    it("refuses malformed items", () => {
      expect(verifyFeedItem(null as any, ctx()).reasons).to.deep.equal(["not an object"]);
      const r = verifyFeedItem({ outcome: "maybe" } as any, ctx());
      expect(r.reasons).to.deep.equal(["missing umid", 'unknown outcome "maybe"', "missing $revs", "missing nodes"]);
    });

    it("works against a remapped neighbourhood", () => {
      const doc = setupDoc({ neighbourhoodRemap: { [members[0].ref]: "r0" } });
      const item = committed("u1", members.slice(1, 4));
      // node r0 signs the attestation under its remapped reference
      item.attestation = { ...attest(members[0], "u1"), node: "r0" };
      item.attestation.sig = ActiveCrypto.signDigest(
        members[0].pair,
        ActiveCrypto.commitDigest("u1", "committed", revs, revsOut, item.attestation.umidDocHash)
      );
      expect(verifyFeedItem(item, verifyContext(doc, NETWORK)).ok).to.equal(true);
    });
  });
});

import { checkPin, neighbourhoodHash } from "../packages/hybrid/src/verify";

describe("hybrid setup pin", () => {
  const setup = { neighbourhood: [{ host: "a", port: 1, identity: { type: "rsa", public: "k" } }], neighbourhoodRemap: {} };

  it("has nothing to check without a pin", () => {
    expect(checkPin(setup).ok).to.equal(true);
  });

  it("accepts the pinned neighbourhood regardless of key order", () => {
    const pin = { neighbourhoodSha256: neighbourhoodHash(setup) };
    const reordered = { neighbourhoodRemap: {}, neighbourhood: [{ identity: { public: "k", type: "rsa" }, port: 1, host: "a" }] };
    expect(checkPin(reordered, pin).ok).to.equal(true);
  });

  it("refuses a setup whose consensus threshold differs", () => {
    const pin = { neighbourhoodSha256: neighbourhoodHash({ ...setup, consensus: { reached: 60 } }) };
    expect(checkPin({ ...setup, consensus: { reached: 60 } }, pin).ok).to.equal(true);
    expect(checkPin({ ...setup, consensus: { reached: 1 } }, pin).ok).to.equal(false);
    expect(checkPin(setup, pin).ok).to.equal(false);
  });

  it("refuses a setup whose voting keys differ", () => {
    const pin = { neighbourhoodSha256: neighbourhoodHash(setup) };
    const swapped = { ...setup, neighbourhood: [{ host: "a", port: 1, identity: { type: "rsa", public: "evil" } }] };
    const r = checkPin(swapped, pin);
    expect(r.ok).to.equal(false);
    expect(r.reason).to.match(/does not match the pin/);
  });
});
