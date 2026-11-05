import { Standard } from "@activeledger/activecontracts";

/**
 * A contract that validates its input and returns a value without writing any
 * state: the lightest realistic contract (a check or a lookup). Used by
 * stress:realistic to show the network's ceiling when contracts do not write.
 */
export default class NoWrite extends Standard {
  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public vote(): Promise<boolean> {
    return Object.keys(this.transactions.$o).length ? Promise.resolve(true) : Promise.reject("Need an output stream");
  }

  public commit(): Promise<any> {
    this.returnToRemote({ via: "no-write-contract" });
    return Promise.resolve(true);
  }
}
