import { Standard, Activity } from "activecontracts";
import { ActiveLogger } from "activelogger";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Fund extends Standard {
  /**
   * Prepared Data for commit
   *
   * @private
   * @type {*}
   * @memberof Fund
   */
  private prepare: any;

  /**
   * Cache the output activity
   *
   * @private
   * @type {Activity}
   * @memberof Fund
   */
  private outputActivity: Activity;

  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!signatureless) {
        resolve(true);
      } else {
        reject("Signatures Needed");
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to checl
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Lets see what we have
      ActiveLogger.debug(this.transactions, "TX");

      // Get the input to verify (and prepare)
      let inputStreams = Object.keys(this.transactions.$i);

      // Only manage 1 input for now
      let inputActivity = this.getActivityStreams(inputStreams[0]);

      // Check they can issue

      // Get the output
      let outputStreams = Object.keys(this.transactions.$o);

      // Only manage 1 output for now
      this.outputActivity = this.getActivityStreams(outputStreams[0]);

      // Output State
      let state = this.outputActivity.getState();

      // Now prepare
      this.prepare = this.transactions.$i[inputStreams[0]];

      // Have we already got this symbol?
      if (state.funds && state.funds[this.prepare.symbol]) {
        return reject("Fund Symbol Exists");
      } else {
        // Approve
        resolve(true);
      }
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Output State
      let state = this.outputActivity.getState();

      // Make sure funds exists
      if (!state.funds) state.funds = {};

      // Update Funds
      state.funds[this.prepare.symbol] = this.prepare.amount;

      // Update State
      this.outputActivity.setState(state);
      resolve(true);
    });
  }
}
