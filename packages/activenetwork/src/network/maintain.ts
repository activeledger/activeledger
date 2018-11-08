/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { ActiveLogger } from "@activeledger/activelogger";
import { Home } from "./home";
import { NeighbourStatus } from "./neighbourhood";
import { Session } from "./session";
import { Neighbour } from "./neighbour";

/**
 * Neighbourhood Maintenance
 * Maintains the status of the network neighbours relative to itself
 *
 * @export
 * @class Watch
 */
export class Maintain {
  /**
   * Mathmatical order of neighbours.
   * Self calculated but will match each none connected node
   *
   * @private
   * @type {string[]}
   * @memberof Maintain
   */
  private neighbourOrder: Neighbour[];

  /**
   * Number of total houses in the neighbourhood
   *
   * @private
   * @type {number}
   * @memberof Maintain
   */
  private houses: number = 0;

  /**
   * Internal flag to see if we are already checking
   *
   * @private
   * @type {boolean}
   * @memberof Maintain
   */
  private checking: boolean = false;

  /**
   * Internal Flag for managing rebasing attempted
   *
   * @private
   * @type {boolean}
   * @memberof Maintain
   */
  private rebasing: boolean = false;

  /**
   * How many seconds between service calls
   * There is a random assignment of +/- 10 seconds.
   *
   * TODO: Change this to minutes + wobble, Then when a knock fails
   * because of connection timeout or cannot connect we can call for a rebase
   * this will reduce load on the network
   *
   * @private
   * @type {number}
   * @memberof Watch
   */
  private readonly interval: number =
    (20 + Math.floor(Math.random() * 15) + -10) * 1000;

  /**
   * Creates an instance of Maintain
   *
   * @param {Home} home
   * @memberof Watch
   */
  constructor(private home: Home, private session: Session) {
    // Order the network
    this.createNetworkOrder();

    // Start the timer
    this.healthTimer(true);

    // Subscribe to rebase call
    this.session.on("rebase", () => {
      this.rebaseNeighbourhood();
    });

    // Subscribe to network resets
    this.session.on("reorder", () => {
      this.createNetworkOrder();
    });
  }

  /**
   * Maintain Network health
   *
   * @private
   * @param {boolean} [boot=false]
   * @memberof Maintain
   */
  private healthTimer(boot: boolean = false) {
    setTimeout(() => {
      this.healthTimer();
    }, this.interval);
    if (!boot) {
      ActiveLogger.debug("Checking Neighbourhood");
      this.checkNeighbourhood();
    }
  }

  /**
   *
   *
   * @private
   * @memberof Maintain
   */
  private createNetworkOrder() {
    // Get all neighbours
    let neighbours = this.home.neighbourhood.get();

    // Get Key Index for looping
    // TODO : Convert this copy code into output from neighbourhood
    let keys = Object.keys(neighbours);
    let i = keys.length;

    // Temporary Array for holding references
    let tempOrder: Neighbour[] = [];

    // Loop all neighbours
    while (i--) {
      // Add to temporary array (Unless stopping)
      if (!neighbours[keys[i]].graceStop) {
        tempOrder.push(neighbours[keys[i]]);
      }
    }

    // sort may move into the neighbour object
    this.neighbourOrder = tempOrder.sort(
      (x, y): number => {
        if (x.reference > y.reference) return 1;
        return -1;
      }
    );
  }

  /**
   * Will rebase the neighbourhood asap
   * TODO: Look into rebasing when Right / Left Knock fails (or another node says we could be wrong)
   *
   * @private
   * @memberof Maintain
   */
  private rebaseNeighbourhood(): void {
    // Only Rebase if recognised
    ActiveLogger.debug("Rebase Request");
    if (
      (!this.rebasing && this.home.getStatus() == NeighbourStatus.Recognised) ||
      this.home.getStatus() == NeighbourStatus.Unrecognised
    ) {
      this.rebasing = true;
      // If still checking wait to retry
      if (this.checking) {
        ActiveLogger.debug("Waiting to Rebase");
        setTimeout(() => {
          this.rebaseNeighbourhood();
        }, 2000);
      } else {
        ActiveLogger.debug("Starting Rebase");
        this.checkNeighbourhood();
        this.rebasing = false;
      }
    }
  }

  /**
   * Checks each neighbour to see if they're home (on line)
   *
   * @private
   * @param {boolean} [force=false]
   * @returns {*}
   * @memberof Maintain
   */
  private async checkNeighbourhood(force: boolean = false): Promise<void> {
    if (this.checking && !force) return;

    // Store current processing reference
    let currentRef = Home.reference;

    // Set checking Flag
    this.checking = true;

    // Get Key Index for looping
    let i = this.neighbourOrder.length;

    // Get All Status
    await Promise.all(
      this.neighbourOrder.map((neighbour: Neighbour) => {
        return new Promise(async (resolve, reject) => {
          neighbour
            .knock("status")
            .then(response => {
              // Still the same network?
              if (currentRef == Home.reference) {
                // Node is Home
                neighbour.isHome = true;

                // May remove this code, For now lets update
                // Child processes about the status for output
                this.session.shout("isHome", {
                  reference: neighbour.reference,
                  isHome: neighbour.isHome
                });
              }
              // Resolve Promise to move on
              resolve();
            })
            .catch(error => {
              // Still the same network?
              if (currentRef == Home.reference) {
                // Node isn't home (Any error is a bad error)
                neighbour.isHome = false;

                // May remove this code, For now lets update
                // Child processes about the status for output
                this.session.shout("isHome", {
                  reference: neighbour.reference,
                  isHome: neighbour.isHome
                });
              }
              // This isn't a failure so resolve to move on.
              resolve();
            });
        });
      })
    );

    // Pair with this nodes neighbour
    if (currentRef == Home.reference) {
      this.pairing();
    } else {
      this.checking = false;
      this.rebasing = false;
    }
  }

  /**
   * Using the order this method will start pairing each active neighbour
   * to its mathmatical left and right. Again this doesn't hit the network
   * these is self calculated
   *
   * TODO: Increase performance by checking current left / right to see if they're still home.
   * TODO: Increase performance if no changes don't do IPC messaging
   *
   * Above TODO's could possibly be done in the checkNeighbourhood above as well.
   *
   * @private
   * @returns {*}
   * @memberof Maintain
   */
  private pairing(): any {
    // Loop Index
    let i: number = this.neighbourOrder.length;

    // Where the home node is in this predictable order.
    // (Undefined for error management)
    let whereHomeIs: number | undefined;

    // Who is the right & left neighbour  of this home position
    // Undefined used for loop condition
    let isRight: Neighbour | undefined;
    let isleft: Neighbour | undefined;

    // Find Home Position
    while (i--) {
      // Match on reference and break
      if (this.home.reference == this.neighbourOrder[i].reference) {
        whereHomeIs = i;
        break;
      }
    }

    // If undefined, We were mid checking during a change over
    // Need to refresh again for references
    if (whereHomeIs == undefined) {
      // No longer checking
      this.checking = false;
      this.rebasing = false;
      return this.session.reload();
    }

    // Loop starting position relative to home
    i = whereHomeIs as number;
    while (!isRight) {
      // Move "right" by one & Stay within range
      if (++i >= this.neighbourOrder.length) i = 0;
      // Neighbour Home to be on our right?
      if (
        this.neighbourOrder[i] &&
        !this.neighbourOrder[i].graceStop &&
        this.neighbourOrder[i].isHome
      )
        isRight = this.neighbourOrder[i];

      // Return Early, Network probably reordered with new nodes
      if (!this.neighbourOrder[i]) return;
    }

    // Now Find left
    i = whereHomeIs as number;
    while (!isleft) {
      // Move "left" by one & Stay within range
      if (--i == -1) i = this.neighbourOrder.length - 1;
      // Neighbour Home to be on our left?
      if (
        this.neighbourOrder[i] &&
        !this.neighbourOrder[i].graceStop &&
        this.neighbourOrder[i].isHome
      )
        isleft = this.neighbourOrder[i];

      // Return Early, Network probably reordered with new nodes
      if (!this.neighbourOrder[i]) return;
    }

    if (
      Home.left.reference != isleft.reference ||
      Home.right.reference != isRight.reference
    ) {
      // Set direct neighbours onto home
      ActiveLogger.debug(
        { left: isleft.reference, right: isRight.reference },
        "New Neighbour Update"
      );
      this.home.setNeighbours(false, isleft.reference, isRight.reference);

      // Let all processes know of our network position
      this.session.shout("neighbour", {
        left: isleft.reference,
        right: isRight.reference
      });
    }

    // No longer checking
    this.checking = false;
    this.rebasing = false;
  }
}
