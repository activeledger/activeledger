import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Writes a marker onto whichever stream its INPUT names, resolving it the way
 * a contract author naturally would: follow `$stream` when the input is
 * labelled, otherwise treat the key as the stream id. That is the same
 * resolution `labelOrKey()` performs in the engine.
 *
 * It exists for tests/network/selfsign-impersonation.ts, and it accepts a
 * self-signed transaction on purpose. A contract that rejects `$selfsign` -
 * as most of the fixtures here do - would make that test pass without ever
 * reaching the question it is asking, which is what the engine hands a
 * contract that has NOT rejected it.
 *
 * So this is deliberately the most permissive contract that could be
 * written against an input. If a self-signed transaction could reach the
 * stream named in `$i.<label>.$stream`, this contract would write to it.
 */
export default class InputTarget extends Standard {
  private activity: Activity;
  private marker: string;

  public verify(_selfsigned: boolean): Promise<boolean> {
    // Self-signed is accepted. See this file's docblock - refusing here
    // would hide the behaviour under test.
    return new Promise<boolean>((resolve) => resolve(true));
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const labels = Object.keys(this.transactions.$i || {});
      if (!labels.length) {
        reject("Need an input");
        return;
      }

      const label = labels[0];
      const value = this.transactions.$i[label];
      // Labelled ($stream) or unlabelled (the key IS the stream id).
      const target = value && value.$stream ? value.$stream : label;

      this.marker = (value && value.marker) || "written";
      this.activity = this.getActivityStreams(target);
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      const state = this.activity.getState();
      state.marker = this.marker;
      this.activity.setState(state);
      this.returnToRemote({ wroteTo: this.activity.getId(), marker: this.marker });
      resolve(true);
    });
  }
}
