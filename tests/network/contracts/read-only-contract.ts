import { Standard } from "@activeledger/activecontracts";

/**
 * Reads a stream named in `$r` and returns that it did. The signer is a
 * signature-only input and there is no output, so nothing is locked and
 * nothing is written: what is measured is the contract running and reading
 * ledger state through the network's agreement.
 */
export default class ReadOnly extends Standard {
  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public vote(): Promise<boolean> {
    return Object.keys((this.transactions as any).$r || {}).length ? Promise.resolve(true) : Promise.reject("Need a stream to read ($r)");
  }

  public commit(): Promise<any> {
    const names = Object.keys((this.transactions as any).$r || {});
    this.returnToRemote({ via: "read-only-contract", read: !!(names.length && this.getReadOnlyStream(names[0])) });
    return Promise.resolve(true);
  }
}
