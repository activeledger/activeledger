import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Votes as the leader only when the transaction asks it to, so the same
 * contract can be run both ways and the two are actually comparable. A
 * contract that votes leader unconditionally has no baseline to measure
 * against - every node becomes its own leader and the run that is supposed
 * to be the control is not one.
 *
 * Everything commit() needs is read in commit(), which is the rule leader
 * mode imposes: vote() runs on the entry node alone, so anything it assigns
 * to `this` is undefined on every other node.
 */
export default class Leader extends Standard {
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise((resolve, reject) =>
      selfsigned ? reject("No self sign") : resolve(true));
  }

  public vote(): Promise<boolean | { leader: boolean }> {
    return new Promise((resolve, reject) => {
      const oStreams = Object.keys(this.transactions.$o);
      if (!oStreams.length) return reject("Need an output stream");
      const payload = this.transactions.$o[oStreams[0]] as { leader?: boolean };
      // Deliberately assigns nothing to `this` - see the class comment.
      resolve(payload.leader ? { leader: true } : true);
    });
  }

  public commit(): Promise<any> {
    return new Promise((resolve, reject) => {
      const oStreams = Object.keys(this.transactions.$o);
      if (!oStreams.length) return reject("Need an output stream");
      const activity: Activity = this.getActivityStreams(oStreams[0]);
      const payload = this.transactions.$o[oStreams[0]] as { message?: string };

      const state = activity.getState();
      state.message = payload.message;
      state.count = (Number(state.count) || 0) + 1;
      activity.setState(state);
      resolve(true);
    });
  }
}
