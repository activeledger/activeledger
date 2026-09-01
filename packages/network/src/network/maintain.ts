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
   * The left/right candidates pairing() last actually acted on - compared
   * against on each call to detect a genuine change, independent of
   * Home.left/Home.right (which only update on a truthy candidate, so
   * comparing directly against them can never represent "still nothing
   * found yet" as a stable, no-change state - every call before a
   * neighbour is first found would otherwise look like a change).
   *
   * @private
   * @type {string | null}
   */
  private static lastPairedLeft: string | null = null;
  private static lastPairedRight: string | null = null;

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
   * True while a healthTimer() polling chain is actively running (started,
   * not yet stopped by full discovery). Guards against two independent
   * chains running in parallel - Maintain.init() (called once from cli.ts
   * at process boot) and Host's own listener-ready callback both call
   * healthTimer(true) for the very same process, which otherwise starts a
   * second, fully redundant chain of its own recursive setTimeout calls -
   * doubling every discovery knock and log line for no benefit. Reset once
   * a chain naturally stops (full discovery), so a later legitimate
   * restart still works.
   *
   * @private
   * @type {boolean}
   */
  private static timerActive: boolean = false;

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
   * Poll fast (300ms) until this node is Stable (paired with a
   * left/right), then at the normal ~10-25s cadence until every
   * *configured* neighbour has actually been discovered - not just the
   * two needed to pair. Stable only means "found 2" - on a network with
   * 3+ neighbours, stopping as soon as that's true left a genuine, live
   * neighbour that just hadn't answered yet permanently undiscovered
   * (nothing left to ever knock it, since reactive tracking only kicks
   * in for a neighbour that's already been marked home at least once).
   * Once every neighbour is accounted for (home or gracefully stopping),
   * this routine full-mesh poll stops entirely: health from then on is
   * tracked reactively instead (see Neighbour's own knock() failure
   * handling, which marks a specific neighbour down and self-polls just
   * that one node until it recovers - and checkNeighbourhood()'s own
   * failure path below, which does the equivalent for a neighbour this
   * node has never yet reached at all).
   *
   * @public
   * @param {boolean} [boot=false]
   */
  public static healthTimer(boot: boolean = false) {
    if (boot) {
      if (Maintain.timerActive) {
        // A chain is already running (see timerActive's own comment) -
        // starting a second one would just double every discovery knock
        // and log line for the rest of the discovery phase, for no
        // benefit.
        return;
      }
      Maintain.timerActive = true;
    }
    if (Maintain.allNeighboursDiscovered()) {
      // First tick where every configured neighbour is accounted for -
      // routine full-mesh polling stops here for good (health tracking
      // continues reactively instead, see Neighbour's own knock()
      // failure handling). Worth a real log line since it won't fire
      // again until a fresh boot or network reset.
      const home = Maintain.neighbourOrder.filter((n) => n.isHome).length;
      const leaving = Maintain.neighbourOrder.filter((n) => n.graceStop).length;
      ActiveLogger.info(
        `Neighbourhood fully discovered (${home} home, ${leaving} leaving, ${Maintain.neighbourOrder.length} configured) - routine polling stopped, health now tracked reactively`
      );
      Maintain.timerActive = false;
      return;
    }
    setTimeout(() => {
      Maintain.healthTimer();
    }, Maintain.getInterval());
    if (!boot) {
      ActiveLogger.debug("Checking Neighbourhood");
      Maintain.checkNeighbourhood();
    }
  }

  /**
   * True once every configured neighbour is either home or intentionally
   * leaving (graceStop) - the point past which the routine full-mesh
   * poll has nothing left to discover.
   *
   * @private
   * @static
   * @returns {boolean}
   */
  private static allNeighboursDiscovered(): boolean {
    return (
      !!Maintain.neighbourOrder &&
      Maintain.neighbourOrder.every(
        (neighbour) => neighbour.isHome || neighbour.graceStop
      )
    );
  }

  /**
   * Cold boot connection to network faster.
   *
   * Was gated on Stable (just 2 paired neighbours - enough for left/right,
   * not enough to have found every configured neighbour on a 3+-node
   * network), not on full discovery - so on a network where Stable is
   * reached before every neighbour has actually responded once, this could
   * jump straight from the fast 300ms boot cadence to the slow 10-25s
   * cadence while neighbours were still genuinely undiscovered. Since
   * healthTimer() already stops polling entirely once
   * allNeighboursDiscovered() is true, there's no reason for an
   * intermediate slow-but-still-polling phase at all - stay fast for the
   * whole discovery phase, however long that takes, then stop.
   *
   * @private
   * @static
   * @returns {number}
   */
  private static getInterval(): number {
    if (!Maintain.allNeighboursDiscovered()) {
      return 300;
    } else {
      return Maintain.interval;
    }
  }

  /**
   * Re-runs pairing with each neighbour's current isHome state, without
   * a network re-knock. Called whenever a neighbour's own reactive health
   * tracking flips its isHome flag (see Neighbour), so left/right update
   * immediately instead of waiting on a routine recheck that no longer
   * runs once Stable.
   *
   * @public
   * @static
   */
  public static pairNow(): void {
    Maintain.pairing();
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
              // Not home yet - nothing more to do here. allNeighboursDiscovered()
              // (above) keeps this fast (300ms) periodic check running until
              // every configured neighbour has been found, so a neighbour that
              // simply hasn't started listening yet just gets retried on the
              // next tick - no need for the separate, much slower (3s) per-
              // neighbour recovery-poll loop to also chase it during boot.
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

    const leftRef = isLeft?.reference ?? null;
    const rightRef = isRight?.reference ?? null;

    if (leftRef !== Maintain.lastPairedLeft || rightRef !== Maintain.lastPairedRight) {
      // Compared against lastPairedLeft/Right, not Home.left/Home.right -
      // those only update on a truthy candidate (setNeighbours() is a
      // no-op for null), so they can never represent "still nothing found
      // yet" as a stable value. Comparing directly against them meant
      // every single call before a neighbour was first found looked like
      // a change, logging (and redundantly calling setNeighbours(), with
      // its subprocess IPC update) on every tick instead of only on an
      // actual topology change.
      Maintain.lastPairedLeft = leftRef;
      Maintain.lastPairedRight = rightRef;

      // A real topology change (who this node routes consensus through),
      // worth an INFO line with host:port rather than raw reference
      // hashes, which aren't meaningful at a glance.
      ActiveLogger.info(
        `Left/right neighbour update - left=${isLeft ? `${isLeft.host}:${isLeft.port}` : "none"} right=${isRight ? `${isRight.host}:${isRight.port}` : "none"}`
      );
      try {
        Maintain.home.setNeighbours(leftRef, rightRef);
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
