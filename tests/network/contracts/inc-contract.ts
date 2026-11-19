import { Standard } from "@activeledger/activecontracts";

/**
 * Inter node comms: every node sets something in vote(), and commit() reads
 * what the other nodes set, so the data really crosses the network in the
 * votes. The result says how many other nodes' data this node saw.
 */
export default class Inc extends Standard {
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      selfsigned ? reject("No self sign") : resolve(true);
    });
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Different on every node, so a node can only have it from the votes
      this.setThisInterNodeComms({ token: Math.random().toString(36).slice(2) + Date.now().toString(36) });
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      const seen: any[] = Object.values(this.getInterNodeComms() || {});
      const withToken = seen.filter((data) => data && typeof data.token === "string");
      this.returnToRemote({ via: "inc-contract", others: seen.length, withToken: withToken.length });
      resolve(true);
    });
  }
}
