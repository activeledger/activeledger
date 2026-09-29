import { Stream, Activity } from "../packages/contracts/src/stream";
import { EventEmitter } from "events";
import { expect } from "chai";
import "mocha";

/**
 * `namespace` on a stream's state is engine-managed authority state:
 * default/contract reads `identity.getState().namespace` to decide who may
 * deploy into a namespace. If any contract could write it, a contract in one
 * namespace could grant itself (or lock someone else out of) another
 * namespace by writing to an identity it references as an output - outputs are
 * not signature-checked by default (see authorisation-model.test.ts).
 *
 * The rule these tests pin down: only a PRIVILEGED contract - one running in
 * the `default` namespace, which is the node's own trusted code - may set
 * `namespace`. Every other contract's write to that key is stripped before the
 * merge, deterministically, so no node diverges. The privilege is derived from
 * the transaction's `$namespace`, exactly as vm.ts and securityScan already
 * treat the default namespace.
 */

const ID = "a".repeat(64);

function activity(privileged: boolean, state: Record<string, unknown> = {}): Activity {
  return new Activity(
    "umid",
    null,
    false,
    new EventEmitter(),
    { _id: `${ID}:stream`, _rev: null } as any,
    { _id: ID, _rev: null, ...state } as any,
    "umid",
    privileged
  );
}

/** A base Stream whose one input is our identity, run under `$namespace`. */
function streamUnderNamespace(namespace: string): Stream {
  const input = {
    meta: { _id: `${ID}:stream`, _rev: null },
    state: { _id: ID, _rev: null },
    volatile: { _id: `${ID}:volatile`, _rev: null },
  } as any;
  const tx = {
    $namespace: namespace,
    $contract: "c",
    $i: { [ID]: {} },
    $o: {},
  } as any;
  return new Stream(
    new Date(),
    "127.0.0.1",
    "umid",
    tx,
    [input],
    [],
    {} as any,
    {} as any,
    {} as any,
    0,
    new EventEmitter(),
    "selfhost"
  );
}

describe("namespace is engine-managed authority state", () => {
  describe("Activity.setState", () => {
    it("strips namespace from a non-privileged contract's write", () => {
      const a = activity(false);
      a.setState({ namespace: "victim", foo: 1 } as any);
      expect(a.getState().namespace).to.equal(undefined);
      // Everything else the contract writes is untouched.
      expect((a.getState() as any).foo).to.equal(1);
    });

    it("keeps namespace from a privileged (default-namespace) contract", () => {
      const a = activity(true);
      a.setState({ namespace: "mine" } as any);
      expect(a.getState().namespace).to.equal("mine");
    });

    it("a non-privileged write can neither set nor overwrite namespace (no hijack, no lock-out)", () => {
      const a = activity(false, { namespace: "rightful-owner" });
      a.setState({ namespace: "attacker", data: 1 } as any);
      // The rightful owner's value is preserved and the attacker's is ignored.
      expect(a.getState().namespace).to.equal("rightful-owner");
      expect((a.getState() as any).data).to.equal(1);
    });
  });

  describe("privilege is derived from the transaction's $namespace", () => {
    it("a default-namespace contract may set an input identity's namespace", () => {
      const stream = streamUnderNamespace("default");
      const act = stream.getActivityStreams(ID);
      act.setState({ namespace: "claimed" } as any);
      expect(act.getState().namespace).to.equal("claimed");
    });

    it("a contract in any other namespace cannot", () => {
      const stream = streamUnderNamespace("attacker-namespace");
      const act = stream.getActivityStreams(ID);
      act.setState({ namespace: "victim" } as any);
      expect(act.getState().namespace).to.equal(undefined);
    });
  });
});
