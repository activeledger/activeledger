import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Creates an identity stream whose id is derived from a caller-supplied seed
 * rather than from the transaction - how an identity is reproduced from a
 * recovery phrase off-chain - and can then update that stream.
 *
 * Exists so the live suite can check what a deterministically seeded stream
 * records about ITSELF: the seed decides the id, but umid and origin have to
 * be real transactions, because SPI, events and history repair all follow
 * them.
 */
export default class SeededIdentity extends Standard {
  public verify(): Promise<boolean> { return new Promise((r) => r(true)); }
  public vote(): Promise<boolean> { return new Promise((r) => r(true)); }
  public commit(): Promise<any> {
    return new Promise((resolve) => {
      const outputs = Object.keys(this.transactions.$o || {});
      if (outputs.length) {
        // An update to an existing seeded stream
        const activity = this.getActivityStreams(outputs[0]);
        const state = activity.getState();
        state.bumped = ((state.bumped as number) || 0) + 1;
        activity.setState(state);
        return resolve(true);
      }
      const label = Object.keys(this.transactions.$i)[0];
      const input = this.transactions.$i[label] as { publicKey: string; type: string };
      const activity: Activity = this.newActivityStream("identity", input.publicKey);
      activity.setAuthority(input.publicKey, input.type);
      const state = activity.getState();
      state.name = activity.getName();
      activity.setState(state);
      resolve(true);
    });
  }
}
