import { Event, Activity } from "@activeledger/activecontracts";

/**
 * Writes a message onto an existing output stream's state and emits a
 * named event carrying the same correlation id, so the test runner can
 * verify events actually arrive over SSE on a real, live 4-node network -
 * not just read from source.
 */
export default class Emitter extends Event {
  private oActivity: Activity;
  private message: string;
  private correlationId: string;

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
      this.correlationId = this.transactions.$o[oStreams[0]].correlationId as string;
      if (!this.message || !this.correlationId) {
        reject("Need a message and correlationId");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      // See returner-contract.ts - deliberately no wall-clock timestamp
      // written into state, since commit() runs independently per node and
      // that would produce a different resulting revision hash on each
      // one.
      const state = this.oActivity.getState();
      state.message = this.message;
      this.oActivity.setState(state);

      this.event.emit("network-test", {
        correlationId: this.correlationId,
        message: this.message,
      });

      resolve(true);
    });
  }
}
