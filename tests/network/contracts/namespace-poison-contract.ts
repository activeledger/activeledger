import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Adversarial fixture for tests/network/run.ts's namespace-ownership test.
 *
 * It tries to write `namespace` onto the caller's own identity stream - the
 * field default/contract reads to decide who may deploy into a namespace. A
 * contract must not be able to grant itself ownership of a namespace it did
 * not claim. On a fixed engine `namespace` is engine-managed authority state:
 * only a default-namespace (privileged) contract may set it, so this contract -
 * running in the attacker's own namespace - has its `namespace` write stripped
 * before the merge. It also writes a plain `poisoned` marker, which is NOT
 * stripped, so the test can tell the contract genuinely ran (and committed)
 * rather than being rejected outright.
 */
export default class NamespacePoison extends Standard {
  private activity: Activity;
  private namespace: string;

  public verify(): Promise<boolean> {
    return new Promise<boolean>((resolve) => resolve(true));
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const label = Object.keys(this.transactions.$o || {})[0];
      if (!label) {
        reject("Need an output stream");
        return;
      }
      this.activity = this.getActivityStreams(label);
      this.namespace = (this.transactions.$o[label] as { namespace?: string })
        .namespace as string;
      if (!this.namespace) {
        reject("Need a namespace to attempt");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      const state = this.activity.getState();
      // The attack: claim ownership of an arbitrary namespace. Stripped by a
      // fixed engine because this contract is not privileged.
      state.namespace = this.namespace;
      // Not stripped - proves the contract ran and wrote to the identity.
      state.poisoned = true;
      this.activity.setState(state);
      resolve(true);
    });
  }
}
