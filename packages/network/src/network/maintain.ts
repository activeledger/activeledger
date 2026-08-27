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
   */
  private static neighbourOrder: Neighbour[];

  /**
   * Internal flag to see if we are already checking
   *
   * @private
   * @type {boolean}
   */
  private static checking: boolean = false;

  /**
   * Internal Flag for managing rebasing attempted
   *
   * @private
   * @type {boolean}
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
   */
  private static readonly interval: number =
    (20 + Math.floor(Math.random() * 15) + -10) * 1000;

  private static home: Home;

  /**
   * Creates an instance of Maintain
   *
   * @param {Home} home
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
   * @public
   * @param {boolean} [boot=false]
   */
  public static healthTimer(boot: boolean = false) {
    setTimeout(() => {
      Maintain.healthTimer();
    }, Maintain.getInterval());
    if (!boot) {
      if (Maintain.home && Maintain.home.getStatus() !== NeighbourStatus.Stable) {
        ActiveLogger.debug("Checking Neighbourhood");
      }
      Maintain.checkNeighbourhood();
    }
  }

  /**
   * Cold boot connection to network faster
   *
   * @private
   * @static
   * @returns {number}
   */
  private static getInterval(): number {
    if (Maintain.home.getStatus() != NeighbourStatus.Stable) {
      return 300;
    } else {
      return Maintain.interval;
    }
  }

  /**
   * Calculates nodes position in a network
   *
   * @private
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
    Maintain.neighbourOrder = tempOrder.sort((x, y): number => {
      if (x.reference > y.reference) return 1;
      return -1;
    });
  }

  /**
   * Will rebase the neighbourhood asap
   *
   * @public
   */
  public static rebaseNeighbourhood(): void {
    // Only Rebase if recognised
    if (
      (!Maintain.rebasing &&
        Maintain.home.getStatus() == NeighbourStatus.Recognised) ||
      Maintain.home.getStatus() == NeighbourStatus.Unrecognised
    ) {
      ActiveLogger.debug("Rebase Request");
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
                // TODO redo all of this
                //neighbour.isHome = false;
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
   */
  private static pairing(): any {
    const order = Maintain.neighbourOrder;
    const orderLength = order.length;

    // Find the current node's index in the sorted list of neighbours.
    const homeIndex = order.findIndex(
      (n) => n.reference === Maintain.home.reference
    );

    // If home is not found (e.g., during a network re-configuration), abort.
    if (homeIndex === -1) {
      // No longer checking
      Maintain.checking = false;
      Maintain.rebasing = false;
      return;
    }

    let isRight: Neighbour | undefined;
    let isLeft: Neighbour | undefined;

    // Find the next available right and left neighbours in a single pass.
    // This is more efficient than separate loops.
    for (let i = 1; i < orderLength; i++) {
      if (!isRight) {
        // Look right (with wrap-around)
        const rightIndex = (homeIndex + i) % orderLength;
        const potentialRight = order[rightIndex];
        if (potentialRight && !potentialRight.graceStop && potentialRight.isHome) {
          isRight = potentialRight;
        }
      }

      if (!isLeft) {
        // Look left (with wrap-around)
        const leftIndex = (homeIndex - i + orderLength) % orderLength;
        const potentialLeft = order[leftIndex];
        if (potentialLeft && !potentialLeft.graceStop && potentialLeft.isHome) {
          isLeft = potentialLeft;
        }
      }

      // If we've found both, we can stop searching.
      if (isRight && isLeft) break;
    }

    if (
      (isLeft && Home.left.reference != isLeft.reference) ||
      Home.right.reference != isRight?.reference
    ) {
      // Set direct neighbours onto home
      ActiveLogger.debug(
        { left: isLeft?.reference, right: isRight?.reference },
        "New Neighbour Update"
      );
      try {
        Maintain.home.setNeighbours(isLeft?.reference || null, isRight?.reference || null);
      }catch{
        ActiveLogger.fatal("Problem setting Right, Try again next loop");
        //this.pairing();
        // Not major problem we only use broadcast
      }
    }

    // No longer checking
    Maintain.checking = false;
    Maintain.rebasing = false;
  }
}
