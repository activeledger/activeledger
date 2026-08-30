import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Exercises this.newActivityStream(name, deterministic) - the deterministic
 * id feature investigated for the false-positive "Deterministic Stream Name
 * Exists" (1530) bug (see streamUpdater.ts's detectCollisions()). Takes the
 * deterministic seed and a stream name from $o so the test runner can drive
 * both a genuinely-fresh seed (expected: commit succeeds) and a repeated
 * seed (expected: a real 1530 collision).
 */
export default class DeterministicStream extends Standard {
  private seed: string;
  private name: string;

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
      const payload = this.transactions.$o[oStreams[0]] as {
        seed?: string;
        name?: string;
      };
      this.seed = payload.seed as string;
      this.name = payload.name as string;
      if (!this.seed || !this.name) {
        reject("Need seed and name");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      const activity: Activity = this.newActivityStream(this.name, this.seed);
      const state = activity.getState();
      state.seed = this.seed;
      activity.setState(state);

      this.returnToRemote({ via: "deterministic-contract", streamId: activity.getState()._id });
      resolve(true);
    });
  }
}
