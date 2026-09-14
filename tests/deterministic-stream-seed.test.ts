import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";
import { ActiveCrypto } from "../packages/crypto/src";

/**
 * newActivityStream(name, deterministic) derives a stream id from an
 * arbitrary seed rather than from the transaction, which is how an identity
 * is reproduced from a recovery phrase off-chain. That seed used to be
 * recorded as the stream's umid and origin too, because one constructor
 * argument was doing both jobs.
 *
 * It mattered once something read those fields. meta.umid is what
 * streamUpdater records as `prev` when building the umid backward chain, so
 * a seeded stream wrote a prev pointing at a umid that never existed and
 * history repair could not walk past it - seen live on a Falcon-512 identity,
 * where the 1196-character public key sitting in `umid` made it obvious.
 *
 * Two things have to hold at once, and they pull in opposite directions:
 * the id must keep coming from the seed (or a recovery phrase would resolve
 * to a different identity than it did yesterday - unrecoverable), while
 * umid/origin must be the transaction (they are what SPI, events and
 * identity recovery follow, in place of an unbounded array of every
 * transaction).
 */
describe("Activity - a deterministic seed must not become the umid", () => {
  const TX_UMID = "a".repeat(64);
  const SEED = "some-deterministic-seed-that-is-not-a-umid";
  const NAME = "identity";

  const make = (seed: string, txUmid?: string) =>
    new Activity(seed, NAME, false, new EventEmitter(), undefined, undefined, txUmid);

  it("still derives the stream id from the SEED", () => {
    // The one thing this fix may never change. Asserted against the hash
    // directly rather than against another Activity, so it pins the
    // derivation itself rather than merely self-consistency.
    const activity = make(SEED, TX_UMID);
    expect(activity.getId()).to.equal(
      ActiveCrypto.Hash.getHash(SEED + NAME, "sha256")
    );
  });

  it("records the TRANSACTION as umid and origin, not the seed", () => {
    const meta = (make(SEED, TX_UMID) as any).meta;
    expect(meta.umid).to.equal(TX_UMID);
    expect(meta.origin).to.equal(TX_UMID);
    expect(meta.umid).to.not.equal(SEED);
    expect(meta.origin).to.not.equal(SEED);
  });

  it("records the transaction on an authority too", () => {
    const activity = make(SEED, TX_UMID);
    activity.setAuthority("a-public-key", "falcon-512");
    const authority = (activity as any).meta.authorities[0];
    expect(authority.umid).to.equal(TX_UMID);
    // The key itself is still the key - that field was always right.
    expect(authority.public).to.equal("a-public-key");
    expect(authority.type).to.equal("falcon-512");
  });

  it("is unchanged when no seed was given", () => {
    // The ordinary case: the id comes from the transaction because that is
    // what was passed as the seed, and umid/origin are the same value.
    const activity = make(TX_UMID);
    const meta = (activity as any).meta;
    expect(activity.getId()).to.equal(
      ActiveCrypto.Hash.getHash(TX_UMID + NAME, "sha256")
    );
    expect(meta.umid).to.equal(TX_UMID);
    expect(meta.origin).to.equal(TX_UMID);
  });

  it("keeps the seed out of the document entirely", () => {
    // Nothing is lost by this: a caller seeding with a public key already
    // has it in authorities[].public, and any other seed is reproducible by
    // whoever knew it. Leaving it in a field that means "transaction" is
    // what caused the problem.
    const activity = make(SEED, TX_UMID);
    activity.setAuthority("a-public-key", "falcon-512");
    expect(JSON.stringify((activity as any).meta)).to.not.contain(SEED);
  });

  it("two streams from the same seed and name are the same stream", () => {
    // The whole point of the feature - and it must not depend on which
    // transaction happened to create it.
    const a = make(SEED, "b".repeat(64));
    const b = make(SEED, "c".repeat(64));
    expect(a.getId()).to.equal(b.getId());
    // ...while each still records its own transaction.
    expect((a as any).meta.umid).to.not.equal((b as any).meta.umid);
  });
});
