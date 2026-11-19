import { Standard } from "@activeledger/activecontracts";
import { HTTP } from "@activeledger/activetoolkits";

/**
 * Makes one HTTP call, with the HTTP toolkit, to the URL it is given and
 * votes yes only if something answered. A contract that cannot reach the
 * storage throws here and the transaction is refused.
 */
export default class StorageProbe extends Standard {
  private url: string;
  private method: string;
  private body: any;

  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public async vote(): Promise<boolean> {
    const streams = Object.keys(this.transactions.$o);
    const given = this.transactions.$o[streams[0]];
    this.url = given.url as string;
    this.method = (given.method as string) || "GET";
    this.body = given.body;
    const reply: any = await HTTP.send(this.url, this.method, undefined, this.body);
    if (!reply || reply.data === null || reply.data === undefined) throw "No answer";
    return true;
  }

  public commit(): Promise<any> {
    return Promise.resolve(true);
  }
}
