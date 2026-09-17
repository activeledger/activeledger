import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Adds, renews or removes an authority on the caller's own identity
 * stream, so the network tests can exercise key expiry end to end.
 *
 * No default contract exposes setAuthorities(), and expiry is only
 * reachable through it - the engine reads `expire` but nothing ships a
 * way to set one.
 *
 * Payload on the input stream:
 *   authority : { public, type, stake, expire? }  - added or renewed
 *   remove    : public key string                 - deleted
 */
export default class AuthorityManager extends Standard {
  private iActivity: Activity;
  private authority: any;
  private remove: string;
  private probe: boolean;

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
      const iStreams = Object.keys(this.transactions.$i);
      if (!iStreams.length) {
        reject("Need an input stream");
        return;
      }
      this.iActivity = this.getActivityStreams(iStreams[0]);
      this.authority = this.transactions.$i[iStreams[0]].authority;
      this.remove = this.transactions.$i[iStreams[0]].remove as string;
      this.probe = this.transactions.$i[iStreams[0]].probe === true;

      // A probe changes nothing. It exists so a test can ask "is this key
      // still allowed to sign?" - the answer is decided in the permissions
      // layer long before vote() runs, so the contract only has to not
      // get in the way.
      if (this.probe) {
        resolve(true);
        return;
      }

      if (!this.authority && !this.remove) {
        reject("Need an authority to add or remove");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Deliberately no wall-clock anything here - commit() runs
      // independently on every node, so a Date.now() in persisted state
      // gives each node a different revision hash.
      try {
        if (this.probe) {
          this.returnToRemote({ probe: true });
          resolve(true);
          return;
        }

        if (this.remove) {
          this.iActivity.deleteAuthorities(this.remove);
        } else {
          this.iActivity.setAuthorities(this.authority);
        }
        this.returnToRemote({
          authorities: this.iActivity.getAuthorities().length,
        });
        resolve(true);
      } catch (e) {
        // The forever-key guard throws from setAuthorities /
        // deleteAuthorities. Surfacing the message is the point - the
        // test asserts on it.
        reject(e.message || e);
      }
    });
  }
}
