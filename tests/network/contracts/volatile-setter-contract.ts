import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Puts a value in the volatile data of the transaction's output stream, the
 * place a node keeps data that is not shared (a key share, say).
 */
export default class VolatileSetter extends Standard {
  private oActivity: Activity;
  private secret: string;

  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public async vote(): Promise<boolean> {
    const oStreams = Object.keys(this.transactions.$o);
    if (!oStreams.length) throw "Need an output stream";
    this.oActivity = this.getActivityStreams(oStreams[0]);
    this.secret = this.transactions.$o[oStreams[0]].secret as string;
    if (!this.secret) throw "Need a secret";
    // The stream's existing volatile document, so the change is written over it
    await this.oActivity.getVolatile();
    return true;
  }

  public commit(): Promise<any> {
    this.oActivity.setVolatile({ secret: this.secret });
    return Promise.resolve(true);
  }
}
