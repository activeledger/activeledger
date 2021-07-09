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
  private static neighbourOrder: Neighbour[];

  /**
   * Internal flag to see if we are already checking
   *
   * @private
   * @type {boolean}
   * @memberof Maintain
   */
  private static checking: boolean = false;

  /**
   * Internal Flag for managing rebasing attempted
   *
   * @private
   * @type {boolean}
   * @memberof Maintain
   */
  private static rebasing: boolean = false;

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
  private static readonly interval: number =
    (20 + Math.floor(Math.random() * 15) + -10) * 1000;

  private static home: Home;

  /**
   * Creates an instance of Maintain
   *
   * @param {Home} home
   * @memberof Watch
   */
  public static init(home: Home) {
    // Move to statics in home
    Maintain.home = home;

    // Order the network
    Maintain.createNetworkOrder();

    // Start the timer
    Maintain.healthTimer(true);
  }

  /**
   * Maintain Network health
   *
   * @private
   * @param {boolean} [boot=false]
   * @memberof Maintain
   */
  private static healthTimer(boot: boolean = false) {
    setTimeout(() => {
      Maintain.healthTimer();
    }, Maintain.interval);
    if (!boot) {
      ActiveLogger.debug("Checking Neighbourhood");
      Maintain.checkNeighbourhood();
    }
  }

  /**
   *
   *
   * @private
   * @memberof Maintain
   */
  private static createNetworkOrder() {
    // Get all neighbours
    let neighbours = Maintain.home.neighbourhood.get();

    // Get Key Index for looping
    let keys = Maintain.home.neighbourhood.keys();
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
    Maintain.neighbourOrder = tempOrder.sort(
      (x, y): number => {
        if (x.reference > y.reference) return 1;
        return -1;
      }
    );
  }

  /**
   * Will rebase the neighbourhood asap
   *
   * @public
   * @memberof Maintain
   */
  public static rebaseNeighbourhood(): void {
    // Only Rebase if recognised
    ActiveLogger.debug("Rebase Request");
    if (
      (!Maintain.rebasing &&
        Maintain.home.getStatus() == NeighbourStatus.Recognised) ||
      Maintain.home.getStatus() == NeighbourStatus.Unrecognised
    ) {
      Maintain.rebasing = true;
      // If still checking wait to retry
      if (Maintain.checking) {
        ActiveLogger.debug("Waiting to Rebase");
        setTimeout(() => {
          Maintain.rebaseNeighbourhood();
        }, 2000);
      } else {
        ActiveLogger.debug("Starting Rebase");
        Maintain.checkNeighbourhood();
        Maintain.rebasing = false;
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
  private static async checkNeighbourhood(
    force: boolean = false
  ): Promise<void> {
    if (Maintain.checking && !force) return;

    // Store current processing reference
    let currentRef = Home.reference;

    // Set checking Flag
    Maintain.checking = true;

    // Get All Status
    await Promise.all(
      Maintain.neighbourOrder.map((neighbour: Neighbour) => {
        return new Promise<void>(async (resolve, reject) => {
          neighbour
            .knock("status")
            .then(() => {
              // Still the same network?
              if (currentRef == Home.reference) {
                // Node is Home
                neighbour.isHome = true;
              }
              // Resolve Promise to move on
              resolve();
            })
            .catch(() => {
              // Still the same network?
              if (currentRef == Home.reference) {
                // Node isn't home (Any error is a bad error)
                neighbour.isHome = false;
              }
              // This isn't a failure so resolve to move on.
              resolve();
            });
        });
      })
    );

    // Pair with this nodes neighbour
    if (currentRef == Home.reference) {
      Maintain.pairing();
    } else {
      Maintain.checking = false;
      Maintain.rebasing = false;
    }
  }

  /**
   * Using the order this method will start pairing each active neighbour
   * to its mathmatical left and right. Again this doesn't hit the network
   * these is self calculated
   *
   * @private
   * @returns {*}
   * @memberof Maintain
   */
  private static pairing(): any {
    // Loop Index
    let i: number = Maintain.neighbourOrder.length;

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
      if (Maintain.home.reference == Maintain.neighbourOrder[i].reference) {
        whereHomeIs = i;
        break;
      }
    }

    // If undefined, We were mid checking during a change over
    // Need to refresh again for references
    if (whereHomeIs == undefined) {
      // No longer checking
      Maintain.checking = false;
      Maintain.rebasing = false;
      return;
    }

    // Loop starting position relative to home
    i = whereHomeIs as number;
    while (!isRight) {
      // Move "right" by one & Stay within range
      if (++i >= Maintain.neighbourOrder.length) i = 0;
      // Neighbour Home to be on our right?
      if (
        Maintain.neighbourOrder[i] &&
        !Maintain.neighbourOrder[i].graceStop &&
        Maintain.neighbourOrder[i].isHome
      )
        isRight = Maintain.neighbourOrder[i];

      // Return Early, Network probably reordered with new nodes
      if (!Maintain.neighbourOrder[i]) return;
    }

    // Now Find left
    i = whereHomeIs as number;
    while (!isleft) {
      // Move "left" by one & Stay within range
      if (--i == -1) i = Maintain.neighbourOrder.length - 1;
      // Neighbour Home to be on our left?
      if (
        Maintain.neighbourOrder[i] &&
        !Maintain.neighbourOrder[i].graceStop &&
        Maintain.neighbourOrder[i].isHome
      )
        isleft = Maintain.neighbourOrder[i];

      // Return Early, Network probably reordered with new nodes
      if (!Maintain.neighbourOrder[i]) return;
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
      Maintain.home.setNeighbours(isleft.reference, isRight.reference);
    }

    // No longer checking
    Maintain.checking = false;
    Maintain.rebasing = false;
  }
}
