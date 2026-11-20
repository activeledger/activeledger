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
import { NeighbourStatus } from "./neighbourstatus";
import type { Neighbour } from "./neighbour";

/**
 * What the pairing logic needs from the node it runs on. Home satisfies it;
 * a test can pass a plain object.
 */
export interface PairingHome {
  reference: string;
  neighbourhood: { get(): any; keys(): string[] };
  getStatus(): NeighbourStatus;
  setNeighbours(left: string | null, right: string | null): void;
}

/**
 * What the pairing logic needs from the outside world: the clock, and the
 * current network reference (it changes when the neighbourhood is replaced,
 * which makes an answer to an older question stale). A test passes a fake
 * clock and drives time by hand.
 */
export interface PairingDeps {
  networkRef(): string;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(timer: any): void;
  now(): number;
}

/**
 * The pairing state machine: finds which configured neighbours are home,
 * keeps asking the ones that are not, and works out this node's left and
 * right neighbour from the answers.
 *
 * It holds all the state and decisions, and touches the outside only through
 * the Neighbour objects it is given (knock, setState) and PairingDeps, so it
 * can be run in a test with fake neighbours and a fake clock. Maintain is the
 * static facade the rest of the node uses.
 *
 * @export
 * @class Pairing
 */
export class Pairing {
  /** Neighbours in their mathematical order (self calculated, matches on every node) */
  public neighbourOrder!: Neighbour[];

  /** Internal flag to see if we are already checking */
  public checking: boolean = false;

  /** Internal flag for managing rebasing attempted */
  public rebasing: boolean = false;

  /**
   * The left/right candidates pairing() last actually acted on - compared
   * against on each call to detect a genuine change, independent of
   * Home.left/Home.right (which only update on a truthy candidate, so
   * comparing directly against them can never represent "still nothing
   * found yet" as a stable, no-change state).
   */
  public lastPairedLeft: string | null = null;
  public lastPairedRight: string | null = null;

  /** Seconds between routine calls, with a random +/- 10 seconds */
  public interval: number = (20 + Math.floor(Math.random() * 15) + -10) * 1000;

  public home: PairingHome;

  /**
   * True while a healthTimer() polling chain is actively running. Guards
   * against two chains running in parallel (Maintain.init() and Host's
   * listener-ready callback both start one for the same process). Reset once
   * a chain naturally stops (full discovery).
   */
  public timerActive: boolean = false;

  /**
   * How many discovery ticks have been scheduled since discovery (re)started.
   * The poll is fast for the first ones, then backs off (see getInterval).
   */
  public discoveryTicks: number = 0;

  /** When each neighbour was last asked by checkNeighbour(), so a burst of signs is one request */
  public lastAsked: { [reference: string]: number } = {};

  /** Neighbours checkNeighbour() has a request out to, so two never overlap */
  public asking: Set<string> = new Set();

  /** A retry waiting to run for a neighbour that did not answer yet */
  public retrying: { [reference: string]: any } = {};

  /**
   * How long to wait before asking a neighbour again that did not answer, for
   * each retry. A neighbour often knocks a moment before it can answer (it is
   * listening but still loading), and until it answers the others do not
   * count it home, so a transaction in that gap skips it. Short first, so the
   * gap is tens of milliseconds and not a flat 300.
   */
  public static readonly RETRY_DELAYS_MS = [25, 50, 100, 200, 300, 300, 300, 300];

  constructor(private deps: PairingDeps) {}

  /**
   * Starts pairing for this node
   *
   * @param {PairingHome} home
   */
  public init(home: PairingHome) {
    // Hold the node
    this.home = home;

    // Order the network
    this.createNetworkOrder();

    // Start the timer
    this.discoveryTicks = 0;
    this.healthTimer(true);
  }

  /**
   * Start again from a neighbourhood that was just replaced (a config
   * reload). The reset builds new Neighbour objects that all start as not
   * home, while the order held here still points at the old ones, and the
   * discovery timer has long stopped, so without this nothing would ever
   * knock the new ones and the node would stay on its own until restarted.
   *
   * @public
   */
  public restart(): void {
    this.createNetworkOrder();
    // Pair afresh, whatever was paired before
    this.lastPairedLeft = null;
    this.lastPairedRight = null;
    this.discoveryTicks = 0;
    this.healthTimer(true);
    this.checkNeighbourhood();
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
  public healthTimer(boot: boolean = false) {
    if (boot) {
      if (this.timerActive) {
        // A chain is already running (see timerActive's own comment) -
        // starting a second one would just double every discovery knock
        // and log line for the rest of the discovery phase, for no
        // benefit.
        return;
      }
      this.timerActive = true;
    }
    if (this.allNeighboursDiscovered()) {
      // First tick where every configured neighbour is accounted for -
      // routine full-mesh polling stops here for good (health tracking
      // continues reactively instead, see Neighbour's own knock()
      // failure handling). Worth a real log line since it won't fire
      // again until a fresh boot or network reset.
      const home = this.neighbourOrder.filter((n) => n.isHome).length;
      const leaving = this.neighbourOrder.filter((n) => n.graceStop).length;
      ActiveLogger.info(
        `Neighbourhood fully discovered (${home} home, ${leaving} leaving, ${this.neighbourOrder.length} configured) - routine polling stopped, health now tracked reactively`
      );
      this.timerActive = false;
      return;
    }
    this.deps.setTimeout(() => {
      this.healthTimer();
    }, this.getInterval());
    if (!boot) {
      ActiveLogger.debug("Checking Neighbourhood");
      this.checkNeighbourhood();
    }
  }

  /**
   * True once every configured neighbour is either home or intentionally
   * leaving (graceStop) - the point past which the routine full-mesh
   * poll has nothing left to discover.
   *
   * @private
   * @returns {boolean}
   */
  public allNeighboursDiscovered(): boolean {
    return (
      !!this.neighbourOrder &&
      this.neighbourOrder.every(
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
   * @returns {number}
   */
  public getInterval(): number {
    if (this.allNeighboursDiscovered()) {
      return this.interval;
    }
    // Fast while the node is booting (about ten seconds), then backing off to
    // one request every ten seconds for a neighbour that is not there. A
    // neighbour that starts later is not waited for on this timer: it knocks
    // this node when it boots, and this node answers by knocking it
    // (this.checkNeighbour, called from the status handler and when its
    // P2P socket connects).
    this.discoveryTicks++;
    if (this.discoveryTicks <= 30) {
      return 300;
    }
    const step = this.discoveryTicks - 30;
    return Math.min(10000, 1000 * 2 ** Math.min(step - 1, 4));
  }

  /**
   * Re-runs pairing with each neighbour's current isHome state, without
   * a network re-knock. Called whenever a neighbour's own reactive health
   * tracking flips its isHome flag (see Neighbour), so left/right update
   * immediately instead of waiting on a routine recheck that no longer
   * runs once Stable.
   *
   * @public
   */
  public pairNow(): void {
    this.pairing();
  }

  /**
   * Calculates nodes position in a network
   *
   * @private
   */
  public createNetworkOrder() {
    // Get all neighbours
    let neighbours = this.home.neighbourhood.get();

    // Get Key Index for looping
    let keys = this.home.neighbourhood.keys();
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
    this.neighbourOrder = tempOrder.sort((x, y): number => {
      if (x.reference > y.reference) return 1;
      return -1;
    });
  }

  /**
   * Will rebase the neighbourhood asap
   *
   * @public
   */
  public rebaseNeighbourhood(): void {
    this.attemptRebase(false);
  }

  /**
   * One rebase attempt. A fresh request from a Recognised node is ignored
   * while one is already pending (rebasing). The 2 second retry of that
   * pending request is the pending request itself, so it must not be
   * ignored by the same flag or a Recognised node would never rebase after
   * waiting for a running check. checkNeighbourhood() does not run twice
   * at once, so retries cannot start concurrent rebases.
   *
   * @private
   * @param {boolean} isRetry
   */
  public attemptRebase(isRetry: boolean): void {
    const status = this.home.getStatus();

    // Only Rebase if recognised
    if (
      (status == NeighbourStatus.Recognised &&
        (isRetry || !this.rebasing)) ||
      status == NeighbourStatus.Unrecognised
    ) {
      ActiveLogger.debug("Rebase Request");
      this.rebasing = true;
      // If still checking wait to retry
      if (this.checking) {
        ActiveLogger.debug("Waiting to Rebase");
        this.deps.setTimeout(() => {
          this.attemptRebase(true);
        }, 2000);
      } else {
        ActiveLogger.debug("Starting Rebase");
        this.checkNeighbourhood();
        this.rebasing = false;
      }
    } else if (isRetry) {
      // No longer needs a rebase, don't leave later requests blocked
      this.rebasing = false;
    }
  }

  /**
   * Checks each neighbour to see if they're home (on line)
   *
   * @private
   * @param {boolean} [force=false]
   * @returns {*}
   */
  public async checkNeighbourhood(
    force: boolean = false
  ): Promise<void> {
    if (this.checking && !force) return;

    // Store current processing reference
    let currentRef = this.deps.networkRef();

    // Set checking Flag
    this.checking = true;

    // Ask only the neighbours not yet known to be home. This node is always
    // home to itself (it used to knock itself to find that out), and a
    // neighbour already home needs no polling: if it goes quiet, the failed
    // send or knock that notices marks it down and starts its own recovery
    // checks (Neighbour.markUnavailable).
    await Promise.all(
      this.neighbourOrder.map((neighbour: Neighbour) => {
        if (neighbour.reference === this.home.reference) {
          neighbour.setState("home");
          return Promise.resolve();
        }
        if (neighbour.isHome) {
          return Promise.resolve();
        }
        // Not home yet - allNeighboursDiscovered() keeps this periodic check
        // running until every configured neighbour has been found, so one that
        // has not started listening is retried on the next tick; no need for
        // the separate per-neighbour recovery poll to chase it during boot.
        return this.probe(neighbour, currentRef);
      })
    );

    // Pair with this nodes neighbour
    if (currentRef == this.deps.networkRef()) {
      this.pairing();
    } else {
      this.checking = false;
      this.rebasing = false;
    }
  }

  /**
   * Asks one neighbour for its status and records the answer. Never rejects:
   * a neighbour that does not answer is just not home yet.
   *
   * @private
   * @param {Neighbour} neighbour
   * @param {string} currentRef The network reference when the check began
   * @returns {Promise<boolean>} true if the neighbour answered
   */
  public probe(neighbour: Neighbour, currentRef: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      neighbour
        .knock("status")
        .then(() => {
          // Still the same network?
          if (currentRef == this.deps.networkRef()) {
            // Node is Home
            neighbour.setState("home");
          }
          resolve(true);
        })
        .catch(() => {
          // Never answered (or refused, see Neighbour.knock): say so, once
          if (neighbour.state === "unknown") {
            neighbour.setState("unreachable", "no answer yet");
          }
          resolve(false);
        });
    });
  }

  /**
   * Looks at one neighbour now, because there is a sign it is up: it just knocked
   * this node, or its P2P socket just connected. Does nothing for a neighbour
   * already home, leaving, or this node itself, never has two requests out to the
   * same neighbour, and never throws. It asks the address in this node's own
   * configuration, never one the sender gave, so a forged request can only
   * cause a few requests to a neighbour this node already knows.
   *
   * A sign of life often comes a moment before the neighbour can answer (its
   * server is up but it is still starting), so a request that gets no answer is
   * tried again after 25, 50, 100, 200 and then every 300 ms (eight times), instead of waiting for the poll.
   *
   * @public
   * @param {Neighbour} neighbour
   * @param {number} [attempt=0] Retries so far (internal)
   */
  public checkNeighbour(neighbour: Neighbour, attempt: number = 0): void {
    if (!this.home || !neighbour || neighbour.isHome || neighbour.graceStop) return;
    const reference = neighbour.reference;
    if (reference === this.home.reference) return;
    if (this.asking.has(reference)) return;
    const now = this.deps.now();
    // A burst of signs (an inbound knock and a socket connecting together) is one request
    if (attempt === 0 && now - (this.lastAsked[reference] || 0) < 250) return;
    // A fresh sign replaces a retry that is still waiting
    if (attempt === 0 && this.retrying[reference]) {
      this.deps.clearTimeout(this.retrying[reference]);
      delete this.retrying[reference];
    }
    this.lastAsked[reference] = now;
    this.asking.add(reference);
    const currentRef = this.deps.networkRef();
    this.probe(neighbour, currentRef).then((answered) => {
      this.asking.delete(reference);
      if (answered) {
        // Pair at once, so this node routes through it without waiting for a poll
        if (currentRef == this.deps.networkRef()) this.pairing();
        return;
      }
      if (attempt < Pairing.RETRY_DELAYS_MS.length && !neighbour.isHome && !neighbour.graceStop) {
        const timer: any = this.deps.setTimeout(() => {
          delete this.retrying[reference];
          this.checkNeighbour(neighbour, attempt + 1);
        }, Pairing.RETRY_DELAYS_MS[attempt]);
        timer?.unref?.();
        this.retrying[reference] = timer;
      }
    });
  }

  /**
   * Using the order this method will start pairing each active neighbour
   * to its mathmatical left and right. Again this doesn't hit the network
   * these is self calculated
   *
   * @private
   * @returns {*}
   */
  public pairing(): any {
    const order = this.neighbourOrder;
    const orderLength = order.length;

    // Find the current node's index in the sorted list of neighbours.
    const homeIndex = order.findIndex(
      (n) => n.reference === this.home.reference
    );

    // If home is not found (e.g., during a network re-configuration), abort.
    if (homeIndex === -1) {
      // No longer checking
      this.checking = false;
      this.rebasing = false;
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

    if (leftRef !== this.lastPairedLeft || rightRef !== this.lastPairedRight) {
      // Compared against lastPairedLeft/Right, not Home.left/Home.right -
      // those only update on a truthy candidate (setNeighbours() is a
      // no-op for null), so they can never represent "still nothing found
      // yet" as a stable value. Comparing directly against them meant
      // every single call before a neighbour was first found looked like
      // a change, logging (and redundantly calling setNeighbours(), with
      // its subprocess IPC update) on every tick instead of only on an
      // actual topology change.
      this.lastPairedLeft = leftRef;
      this.lastPairedRight = rightRef;

      // A real topology change (who this node routes consensus through),
      // worth an INFO line with host:port rather than raw reference
      // hashes, which aren't meaningful at a glance.
      ActiveLogger.info(
        `Left/right neighbour update - left=${isLeft ? `${isLeft.host}:${isLeft.port}` : "none"} right=${isRight ? `${isRight.host}:${isRight.port}` : "none"}`
      );
      try {
        this.home.setNeighbours(leftRef, rightRef);
      }catch{
        ActiveLogger.fatal("Problem setting Right, Try again next loop");
        //this.pairing();
        // Not major problem we only use broadcast
      }
    }

    // No longer checking
    this.checking = false;
    this.rebasing = false;
  }
}
