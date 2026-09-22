import { Process } from "../packages/protocol/src/protocol/process";
import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
import { Shared } from "../packages/protocol/src/protocol/shared";
import { Stream, Activity } from "../packages/contracts/src/stream";
import { ActiveCrypto } from "../packages/crypto/src";
import { EventEmitter } from "events";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A self-signed transaction cannot impersonate the identity it names in
 * `$i.<label>.$stream`.
 *
 * `$selfsign` exists for the case where there is no on-ledger identity yet -
 * onboarding. It therefore has no authority to check a signature against, so
 * `process.ts` takes a separate branch that verifies each `$i` entry against
 * `$i[label].publicKey`: a key the transaction carries ABOUT ITSELF. Anyone
 * satisfies that with a freshly generated keypair, and this suite proves it
 * rather than assuming it.
 *
 * What stops that being an impersonation is that the same branch never
 * resolves `$i` to a stream at all - it calls
 * `this.process([], outputStreams, ...)` with a hard-coded empty input list.
 * The victim's stream is never fetched, never authority-checked, and never
 * handed to the contract. The `$stream` field is inert.
 *
 * That is a quiet protection: nothing about `this.process([], ...)` announces
 * that it is load-bearing, and `labelOrKey()` has already rewritten
 * `this.inputs` to the victim's stream id by the time it runs. A refactor
 * that started reading `this.inputs` on that branch - or that "tidied" the
 * empty array into `this.inputs` for symmetry with the branch above - would
 * hand an attacker with one throwaway keypair a writable handle on anyone's
 * stream, and nothing would have failed. These tests are the thing that
 * fails.
 *
 * Reproduced in a re-implementation of the engine, which is where this
 * actually bit: nano read `$i` for a self-signed transaction the way it reads
 * every other one, and so attested to a stream the ledger had never loaded.
 * The live counterpart is `tests/network/selfsign-impersonation.ts`.
 */

const VICTIM = "b3d41e5f8a2c7d90416253a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081";

/** A real keypair. A stubbed signature check would prove nothing here. */
function keys(type = "rsa") {
  const kp = new ActiveCrypto.KeyPair(type);
  const generated = kp.generate();
  return { kp, pub: generated.pub.pkcs8pem as string };
}

const victim = keys();
const attacker = keys();

/**
 * Drives the real `Process.start()` as far as the self-signed branch and
 * records what it hands the contract.
 *
 * The collaborators are injected onto a bare prototype instance rather than
 * built for real (the pattern `write-paths.test.ts` uses): the point is to
 * observe one control-flow decision, and a real VM, storage layer and
 * neighbourhood would only make it harder to see which of them answered.
 */
async function runSelfSigned(entry: any) {
  const proc: any = Object.create(Process.prototype);

  // A real file, because start() stats it before doing anything else.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfsign-test-"));
  const contractFile = path.join(dir, "contract.js");
  fs.writeFileSync(contractFile, "module.exports = {};");

  // Pre-seeded so setupLocation() short-circuits instead of walking a
  // contracts/ directory this test has no reason to create.
  (Process as any).contractPathCache[entry.$tx.$contract] = contractFile;
  (Process as any).generalContractVM = {};

  const permissionCalls: Array<{ streams: string[]; inputs: boolean }> = [];
  const signatureChecks: Array<{ publicKey: string; type: string }> = [];
  const raised: Array<{ code: number; reason: any }> = [];

  proc.entry = entry;
  proc.reference = "self";
  proc.contractLocation = contractFile;
  proc.isDefault = false;
  proc.shared = {
    ioLabelMap: { i: {}, o: {} },
    sigOnly: {},
    signatureCheck: (publicKey: string, _signature: string, type: string) => {
      signatureChecks.push({ publicKey, type });
      // The real check, against the key the TRANSACTION supplied. Stubbing
      // it true would hide the property this file exists to state.
      return new ActiveCrypto.KeyPair(type, publicKey).verify(entry.$tx, _signature);
    },
    raiseLedgerError: (code: number, reason: any) => {
      raised.push({ code, reason });
    },
  };
  proc.permissionChecker = {
    // Returns a resolved stream for everything it is asked about, rather
    // than an empty array. An empty one would make the assertion below pass
    // no matter what the engine resolved, which is exactly the kind of
    // vacuous green this file exists to prevent.
    process: async (streams: string[], inputs: boolean = true) => {
      permissionCalls.push({ streams: [...streams], inputs });
      return streams.map((id) => ({
        state: { _id: id },
        meta: { _id: `${id}:stream` },
        volatile: { _id: `${id}:volatile` },
      }));
    },
    prefetch: async () => undefined,
  };

  // What the contract actually receives. Captured instead of executed - the
  // VM is not what is under test.
  let handedToContract: string[] | undefined;
  proc.process = async (inputs: any[]) => {
    handedToContract = inputs.map((s: any) => s?.state?._id ?? s);
  };
  proc.getContractDate = async (d: any) => d;
  proc.postVote = (_vm: any, error: any) => raised.push({ code: error?.code, reason: error?.reason });
  proc.emit = () => undefined;
  proc.emitFailed = () => undefined;

  await proc.start(undefined, { _id: "", data: {} });

  fs.rmSync(dir, { recursive: true, force: true });
  return { proc, handedToContract, permissionCalls, signatureChecks, raised };
}

/**
 * A self-signed transaction whose only input names the victim's stream.
 *
 * `$o` is a parameter rather than something a caller mutates afterwards: the
 * signature covers the whole `$tx`, so editing it post-signing produces a
 * 1250 rejection and a test that passes for the wrong reason.
 */
function impersonatingEntry(
  { signer = attacker, publicKey = attacker.pub, $o = {} as Record<string, unknown> } = {}
) {
  const $tx = {
    $namespace: "test",
    $contract: "anything",
    $i: {
      // The label is arbitrary - the self-signed branch keys $sigs by it.
      spoof: { $stream: VICTIM, publicKey, type: "rsa", amount: 1 },
    },
    $o,
  };
  return {
    $umid: "umid-impersonation",
    $tx,
    $sigs: { spoof: signer.kp.sign($tx) },
    $revs: { $i: {}, $o: {} },
    $nodes: { self: {} },
    $selfsign: true,
  } as any;
}

describe("$selfsign cannot impersonate the identity named in $i.<label>.$stream", () => {
  describe("the engine hands the contract no input streams at all", () => {
    it("runs the contract with an empty input list, whatever $i names", async () => {
      const { handedToContract } = await runSelfSigned(impersonatingEntry());

      expect(handedToContract, "the contract must be reached at all").to.not.equal(undefined);
      expect(
        handedToContract,
        "a self-signed transaction resolves NO input streams - this is the whole protection"
      ).to.deep.equal([]);
    });

    it("never asks the permission checker about the victim's stream", async () => {
      const { permissionCalls } = await runSelfSigned(impersonatingEntry());

      // Outputs only, and explicitly as outputs. An input call here would
      // mean the victim's stream had been fetched and revision-checked,
      // which is the first half of taking it over.
      expect(permissionCalls.every((c) => c.inputs === false)).to.equal(
        true,
        `permissionChecker.process was called for inputs: ${JSON.stringify(permissionCalls)}`
      );
      expect(
        permissionCalls.some((c) => c.streams.includes(VICTIM)),
        "the victim's stream must never be looked up"
      ).to.equal(false);
    });

    it("keeps that true even when $o is populated", async () => {
      // Outputs ARE fetched on this branch. The assertion is specifically
      // that a stream named only by $i does not join them.
      const { permissionCalls, handedToContract } = await runSelfSigned(
        impersonatingEntry({ $o: { someOtherStream: {} } })
      );

      expect(handedToContract).to.deep.equal([]);
      expect(permissionCalls).to.have.length(1);
      expect(permissionCalls[0].inputs).to.equal(false);
      expect(permissionCalls[0].streams).to.deep.equal(["someOtherStream"]);
    });
  });

  describe("the signature it does check proves nothing about identity", () => {
    it("accepts a keypair generated seconds ago, with no ledger presence whatsoever", async () => {
      // Stated outright rather than left implied. The self-signed branch is
      // not weak by accident - it has nothing to check against - and the
      // safety comes entirely from the test above, not from this one.
      const { signatureChecks, handedToContract, raised } = await runSelfSigned(
        impersonatingEntry()
      );

      expect(raised, `the transaction should not have been rejected: ${JSON.stringify(raised)}`)
        .to.have.length(0);
      expect(handedToContract).to.deep.equal([]);
      expect(signatureChecks).to.have.length(1);
      expect(
        signatureChecks[0].publicKey,
        "the key checked is the one the transaction supplied about itself"
      ).to.equal(attacker.pub);
      expect(signatureChecks[0].publicKey).to.not.equal(victim.pub);
    });

    it("still rejects a signature that does not match the key beside it", async () => {
      // The check is real. An attacker must at least hold the private key for
      // the public key they wrote in - otherwise this test would pass against
      // an engine that had stopped checking anything.
      const { raised, handedToContract } = await runSelfSigned(
        impersonatingEntry({ publicKey: victim.pub })
      );

      expect(handedToContract, "the contract must not run").to.equal(undefined);
      expect(raised.map((r) => r.code)).to.contain(1250);
    });

    it("rejects an input carrying no publicKey at all", async () => {
      const entry = impersonatingEntry();
      delete entry.$tx.$i.spoof.publicKey;
      // Re-signed, so this fails on the missing key rather than on a
      // signature that no longer covers the payload.
      entry.$sigs.spoof = attacker.kp.sign(entry.$tx);

      const { raised, handedToContract } = await runSelfSigned(entry);

      expect(handedToContract).to.equal(undefined);
      expect(raised.map((r) => r.code)).to.contain(1255);
    });
  });

  describe("labelOrKey() still resolves $i - the protection is that nothing reads it", () => {
    it("rewrites this.inputs to the victim's stream id, and it is used anyway", async () => {
      // Deliberately asserting the trap, not just the safe outcome.
      //
      // labelOrKey() runs before the $selfsign branch is chosen, so by the
      // time the branch is taken, `this.inputs` reads ["<victim>"] and
      // `shared.ioLabelMap.i` maps the victim to the attacker's label. Both
      // look exactly like a resolved, authorised input and neither has been
      // checked against anything. Anything that starts consuming them on
      // this path is the bug; this test is what notices.
      const { proc, handedToContract } = await runSelfSigned(impersonatingEntry());

      expect(proc.inputs, "labelOrKey() does resolve it").to.deep.equal([VICTIM]);
      expect(proc.shared.ioLabelMap.i[VICTIM]).to.equal("spoof");
      expect(
        handedToContract,
        "...and it must still not reach the contract"
      ).to.deep.equal([]);
    });
  });

  describe("contrast: an ordinary transaction naming the same stream IS checked", () => {
    const streamDocs = () => [
      { doc: { _id: VICTIM, _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 10 } },
      {
        doc: {
          _id: `${VICTIM}:stream`,
          _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          authorities: [{ public: victim.pub, type: "rsa", hash: "" }],
        },
      },
    ];

    function normalEntry(signer: { kp: any }) {
      const $tx = {
        $namespace: "test",
        $contract: "anything",
        $i: { [VICTIM]: { amount: 1 } },
        $o: {},
      };
      return {
        $umid: "umid-ordinary",
        $tx,
        $sigs: { [VICTIM]: signer.kp.sign($tx) },
        $revs: { $i: {}, $o: {} },
        $nodes: {},
      } as any;
    }

    function checkerFor(entry: any) {
      const db: any = { allDocs: async () => ({ rows: streamDocs() }) };
      const shared = new Shared(false, entry, db, null as any);
      const securityCache: any = { namespace: {}, hardenedKeys: false, signedOutputs: undefined };
      return new PermissionsChecker(entry, db, securityCache, shared);
    }

    it("rejects the attacker's key against the victim's stream", async () => {
      // This is what `$selfsign` skips, and why skipping it would matter if
      // the stream were resolved. 1220 is the whole difference.
      let rejection: any;
      try {
        await checkerFor(normalEntry(attacker)).process([VICTIM], true);
      } catch (e) {
        rejection = e;
      }

      expect(rejection, "a stranger must not pass the ordinary input path").to.not.equal(undefined);
      expect(rejection.code).to.equal(1220);
      expect(rejection.reason).to.contain("Input Signature Incorrect");
    });

    it("accepts the rightful owner, so the rejection above is about authority", async () => {
      const streams = await checkerFor(normalEntry(victim)).process([VICTIM], true);
      expect(streams).to.have.length(1);
      expect(streams[0].state._id).to.equal(VICTIM);
    });
  });
});

describe("A stream reached as an output cannot be taken over either", () => {
  /**
   * The second half of "cannot impersonate": suppose an attacker stops
   * trying to forge an input and simply names the stream in `$o`, which
   * needs no signature by design.
   *
   * What they get is limited write status, not the identity. `Stream`'s
   * constructor builds output activities with `signature = false` and
   * `name = null`, and every method that could actually take a stream over -
   * the authority list, the contract and namespace locks - is gated on
   * `this.signature || (this.umid && this.name)`: an authenticated INPUT, or
   * a stream being created right now. An output is neither, so those calls
   * do nothing at all.
   *
   * That gate is what makes contract/namespace locking a usable control:
   * a lock set when a stream is created cannot be lifted by anything that
   * merely reaches the stream through `$o`.
   */
  const meta = () => ({
    _id: `${VICTIM}:stream`,
    _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authorities: [{ public: victim.pub, type: "rsa", hash: "vh", stake: 100 }],
    contractlock: ["the-only-contract"],
  });

  const outputActivity = () =>
    new Activity("umid-out", null, false, new EventEmitter(), meta() as any, {
      _id: VICTIM,
      _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      balance: 10,
    } as any);

  /** The same stream reached as a SIGNED input - the discriminating case. */
  const inputActivity = () =>
    new Activity("umid-in", null, true, new EventEmitter(), meta() as any, {
      _id: VICTIM,
      _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      balance: 10,
    } as any);

  it("cannot add an authority through an output - it refuses outright", () => {
    const activity = outputActivity();

    expect(() =>
      activity.setAuthorities({ public: attacker.pub, type: "rsa", stake: 100 } as any)
    ).to.throw("Cannot set new authorities on output stream");

    const authorities = activity.getAuthorities();
    expect(authorities).to.have.length(1);
    expect(authorities[0].public).to.equal(victim.pub);
    expect(
      authorities.some((a) => a.public === attacker.pub),
      "an attacker key must not be able to join the authority list via $o"
    ).to.equal(false);
  });

  it("cannot remove the rightful authority through an output", () => {
    const activity = outputActivity();

    expect(() => activity.deleteAuthorities(victim.pub)).to.throw(
      "Cannot delete authorities on output stream"
    );

    expect(activity.getAuthorities()).to.have.length(1);
    expect(activity.getAuthorities()[0].public).to.equal(victim.pub);
  });

  it("cannot lift the contract or namespace lock through an output", () => {
    const activity = outputActivity();

    expect(activity.setContractLock("attacker-contract")).to.equal(false);
    expect(activity.setNamespaceLock("attacker-namespace")).to.equal(false);
    expect((activity as any).meta.contractlock).to.deep.equal(["the-only-contract"]);
    expect((activity as any).meta.namespaceLock).to.equal(undefined);
  });

  it("CAN do all of that through a signed input, so the above is not vacuous", () => {
    const activity = inputActivity();
    activity.setAuthorities({ public: attacker.pub, type: "rsa", stake: 100 } as any);

    expect(
      activity.getAuthorities().some((a) => a.public === attacker.pub),
      "an authenticated input really can change authorities - these tests can tell the difference"
    ).to.equal(true);
  });
});

describe("Stream: a self-signed $i is not reachable through getActivityStreams()", () => {
  /**
   * The contract's own view of the same fact. `Stream` is constructed with
   * whatever `process()` passed, so for a self-signed transaction the inputs
   * array is empty and the victim has no activity. A contract that resolves
   * its input the ordinary way - `getActivityStreams(this.transactions.$i[label])`,
   * which follows `$stream` - gets a brand-new stream instead of the victim's.
   */
  function selfSignedStream() {
    const transactions: any = {
      $namespace: "test",
      $contract: "anything",
      $i: { spoof: { $stream: VICTIM, publicKey: attacker.pub, type: "rsa" } },
      $o: {},
    };
    return {
      transactions,
      stream: new Stream(
        new Date(),
        "localhost",
        "umid-stream-test",
        transactions,
        // The empty input list the self-signed branch passes.
        [],
        [],
        {},
        { _id: "", data: {} } as any,
        { spoof: "a-signature" } as any,
        0,
        new EventEmitter(),
        "localhost:5259"
      ),
    };
  }

  it("resolves the $i value to a new stream, never the victim's", () => {
    const { stream, transactions } = selfSignedStream();

    const activity = stream.getActivityStreams(transactions.$i.spoof);

    // getId(), not getState()._id - getState() strips _id and _rev, so
    // reading the id from it compares undefined against the victim and
    // passes no matter what the engine did.
    expect(activity.getId(), "a fresh stream, derived from this transaction's umid").to.be.a("string");
    expect(activity.getId()).to.not.equal(VICTIM);
  });

  it("holds no activity for the victim under its own id either", () => {
    const { stream } = selfSignedStream();

    const activity = stream.getActivityStreams(VICTIM);
    expect(activity.getId()).to.be.a("string");
    expect(activity.getId()).to.not.equal(VICTIM);
  });

  it("and writing to what it did resolve cannot touch the victim's state", () => {
    const { stream, transactions } = selfSignedStream();

    const activity = stream.getActivityStreams(transactions.$i.spoof);
    activity.setState({ balance: 999999 } as any);

    expect(activity.getId()).to.be.a("string");
    expect(activity.getId()).to.not.equal(VICTIM);
    expect((activity.getState() as any).balance).to.equal(999999);
  });
});
