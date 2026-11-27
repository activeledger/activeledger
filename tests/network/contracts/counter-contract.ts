import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * The returner contract that also counts how many times it has run on a
 * stream, so a test can see how often a signed transaction was applied.
 */
export default class Counter extends Standard {
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
      // Deliberately no wall-clock timestamp written into state here -
      // commit() runs independently on every node (see architecture.md),
      // so anything non-deterministic like new Date() written into
      // persisted state produces a genuinely different resulting revision
      // hash per node. Invisible on a single run, but running this
      // contract twice against the same stream (as the SPI tests in
      // tests/network/run.ts do) surfaces it immediately as multi-way
      // "Input Stream Position Incorrect" disagreement on the second run -
      // found and root-caused while building that test.
      const state = this.oActivity.getState();
      state.message = this.message;
      state.count = ((state.count as number) || 0) + 1;
      this.oActivity.setState(state);

      this.returnToRemote({ via: "returner-contract", echoedMessage: this.message });
      resolve(true);
    });
  }
}
