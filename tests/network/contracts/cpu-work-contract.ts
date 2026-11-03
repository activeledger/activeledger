import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * A deliberately CPU-heavy contract, for the stress tools (tests/stress).
 * The returner contract does almost nothing, so it measures consensus and
 * storage; this one makes the contract worker do real work and churn the
 * young generation of V8's heap, which is what worker settings (cpus,
 * worker_semi_space) act on.
 *
 * Per transaction, in commit(): builds 6000 small objects from a seeded
 * linear congruential generator, sorts them, round-trips them through
 * JSON.stringify and JSON.parse, then folds them into a checksum written to
 * the stream. Everything is derived from the message, so every node computes
 * the same state (a contract runs independently on each node; anything
 * non-deterministic, such as the time, would make the revisions differ).
 *
 * Same input and output shape as returner-contract: it writes `message` onto
 * the caller's own stream and returns it.
 */
export default class CpuWork extends Standard {
  private oActivity: Activity;
  private message: string;

  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (selfsigned) {
        reject("No self sign");
      } else {
        resolve(true);
      }
    });
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const oStreams = Object.keys(this.transactions.$o);
      if (!oStreams.length) {
        reject("Need an output stream");
        return;
      }
      this.oActivity = this.getActivityStreams(oStreams[0]);
      this.message = this.transactions.$o[oStreams[0]].message as string;
      if (!this.message) {
        reject("Need a message");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      let seed = this.message.length;
      const rows: any[] = [];
      for (let i = 0; i < 6000; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        rows.push({ k: seed, name: "row-" + seed, tags: [i, seed % 7, "t" + (seed % 13)] });
      }
      rows.sort((a, b) => a.k - b.k);
      const back = JSON.parse(JSON.stringify(rows));
      let sum = 0;
      for (const r of back) sum = (sum + r.k + r.tags[1]) % 1000003;
      const state = this.oActivity.getState();
      state.message = this.message;
      state.checksum = sum;
      this.oActivity.setState(state);
      this.returnToRemote({ via: "cpu-work-contract", checksum: sum });
      resolve(true);
    });
  }
}
