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

import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { Pairing } from "./pairing";

/**
 * Neighbourhood Maintenance
 * Maintains the status of the network neighbours relative to itself.
 *
 * The logic lives in Pairing (a state machine with an injected clock, so it
 * can be tested without a network). This class is the static entry point the
 * node uses, holding the one Pairing for the process. The accessors below
 * pass straight through to it.
 *
 * @export
 * @class Maintain
 */
export class Maintain {
  /** The pairing state machine for this process */
  private static engine: Pairing = new Pairing({
    networkRef: () => Home.reference,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
  });

  private static get checking(): boolean {
    return Maintain.engine.checking as any;
  }
  private static set checking(value: boolean) {
    Maintain.engine.checking = value as any;
  }

  private static get rebasing(): boolean {
    return Maintain.engine.rebasing as any;
  }
  private static set rebasing(value: boolean) {
    Maintain.engine.rebasing = value as any;
  }

  private static get lastPairedLeft(): string | null {
    return Maintain.engine.lastPairedLeft as any;
  }
  private static set lastPairedLeft(value: string | null) {
    Maintain.engine.lastPairedLeft = value as any;
  }

  private static get lastPairedRight(): string | null {
    return Maintain.engine.lastPairedRight as any;
  }
  private static set lastPairedRight(value: string | null) {
    Maintain.engine.lastPairedRight = value as any;
  }

  private static get interval(): number {
    return Maintain.engine.interval as any;
  }
  private static set interval(value: number) {
    Maintain.engine.interval = value as any;
  }

  private static get home(): Home {
    return Maintain.engine.home as any;
  }
  private static set home(value: Home) {
    Maintain.engine.home = value as any;
  }

  private static get timerActive(): boolean {
    return Maintain.engine.timerActive as any;
  }
  private static set timerActive(value: boolean) {
    Maintain.engine.timerActive = value as any;
  }

  private static get discoveryTicks(): number {
    return Maintain.engine.discoveryTicks as any;
  }
  private static set discoveryTicks(value: number) {
    Maintain.engine.discoveryTicks = value as any;
  }

  private static get lastAsked(): { [reference: string]: number } {
    return Maintain.engine.lastAsked as any;
  }
  private static set lastAsked(value: { [reference: string]: number }) {
    Maintain.engine.lastAsked = value as any;
  }

  private static get asking(): Set<string> {
    return Maintain.engine.asking as any;
  }
  private static set asking(value: Set<string>) {
    Maintain.engine.asking = value as any;
  }

  private static get retrying(): { [reference: string]: any } {
    return Maintain.engine.retrying as any;
  }
  private static set retrying(value: { [reference: string]: any }) {
    Maintain.engine.retrying = value as any;
  }

  private static get neighbourOrder(): Neighbour[] {
    return Maintain.engine.neighbourOrder as any;
  }
  private static set neighbourOrder(value: Neighbour[]) {
    Maintain.engine.neighbourOrder = value as any;
  }

  /** Creates the neighbour order and starts discovery */
  public static init(home: Home) {
    Maintain.engine.init(home);
  }

  /** Start again from a neighbourhood that was just replaced (a config reload) */
  public static restart(): void {
    Maintain.engine.restart();
  }

  /** The discovery poll, see Pairing.healthTimer */
  public static healthTimer(boot: boolean = false) {
    Maintain.engine.healthTimer(boot);
  }

  /** Re-runs pairing with each neighbour's current isHome state, without a network request */
  public static pairNow(): void {
    Maintain.engine.pairNow();
  }

  /** Will rebase the neighbourhood asap */
  public static rebaseNeighbourhood(): void {
    Maintain.engine.rebaseNeighbourhood();
  }

  /** Looks at one neighbour now because there is a sign it is up, see Pairing.checkNeighbour */
  public static checkNeighbour(neighbour: Neighbour, attempt: number = 0): void {
    Maintain.engine.checkNeighbour(neighbour, attempt);
  }

  private static allNeighboursDiscovered(): boolean {
    return Maintain.engine.allNeighboursDiscovered();
  }

  private static getInterval(): number {
    return Maintain.engine.getInterval();
  }

  private static createNetworkOrder(): void {
    Maintain.engine.createNetworkOrder();
  }

  private static attemptRebase(isRetry: boolean): void {
    Maintain.engine.attemptRebase(isRetry);
  }

  private static checkNeighbourhood(force: boolean = false): Promise<void> {
    return Maintain.engine.checkNeighbourhood(force);
  }

  private static probe(neighbour: Neighbour, currentRef: string): Promise<boolean> {
    return Maintain.engine.probe(neighbour, currentRef);
  }

  private static pairing(): any {
    return Maintain.engine.pairing();
  }
}
