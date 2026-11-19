import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Writes a value into the output stream's volatile data in one of two ways:
 *   "load"  - getVolatile() first (what a contract does to update it)
 *   "plain" - setVolatile() with no read first
 * A failed getVolatile (no volatile document on this node) is caught.
 */
export default class VolatileModes extends Standard {
  private oActivity: Activity;
  private value: string;

  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public async vote(): Promise<boolean> {
    const oStreams = Object.keys(this.transactions.$o);
    const given = this.transactions.$o[oStreams[0]];
    this.oActivity = this.getActivityStreams(oStreams[0]);
    this.value = given.value as string;
    if (given.mode === "load") {
      try {
        await this.oActivity.getVolatile();
      } catch (e) {
        // no volatile document on this node
      }
    }
    return true;
  }

  public commit(): Promise<any> {
    this.oActivity.setVolatile({ written: this.value });
    return Promise.resolve(true);
  }
}
