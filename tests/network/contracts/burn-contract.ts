import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Burns a caller-specified amount of CPU inside commit(), so the profiler can
 * vary how much work a transaction costs and watch what that does to the gap
 * between a 1-node and a 4-node network.
 *
 * That gap is the whole question: if consensus is mostly transport, adding
 * contract work leaves it flat, because the extra work happens on every node
 * in parallel. If consensus is mostly the other nodes *repeating* the work
 * after the origin has finished, the gap grows roughly 1:1 with the burn.
 *
 * The burn is a fixed integer loop rather than a wall-clock deadline on
 * purpose - commit() runs independently on every node, so anything that reads
 * the clock produces a different result per node and diverges the ledger (the
 * exact bug the comment in returner-contract.ts records).
 */
export default class Burn extends Standard {
  private oActivity: Activity;
  private iterations: number;
  private message: string;

  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise((resolve, reject) =>
      selfsigned ? reject("No self sign") : resolve(true));
  }

  public vote(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const oStreams = Object.keys(this.transactions.$o);
      if (!oStreams.length) return reject("Need an output stream");
      this.oActivity = this.getActivityStreams(oStreams[0]);
      const payload = this.transactions.$o[oStreams[0]] as {
        iterations?: number; message?: string;
      };
      this.iterations = Number(payload.iterations) || 0;
      this.message = payload.message as string;
      if (!this.message) return reject("Need a message");
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise((resolve) => {
      // Deterministic busy work - the result is written into state so nothing
      // can optimise the loop away.
      let acc = 0;
      for (let i = 0; i < this.iterations; i++) acc = (acc + i * 7) % 2147483647;

      const state = this.oActivity.getState();
      state.message = this.message;
      state.acc = acc;
      this.oActivity.setState(state);
      resolve(true);
    });
  }
}
