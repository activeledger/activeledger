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

import * as events from "events";
import * as cluster from "cluster";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Locker } from "./locker";
import { Home } from "./home";

/**
 * Manage Processes for this Activeledger instance
 *
 * @export
 * @class Session
 */
export class Session extends events.EventEmitter {
  /**
   * Maintains a list of all forked processes in the cluster
   *
   * @private
   * @type {cluster.Worker[]}
   * @memberof Session
   */
  private workers: cluster.Worker[] = new Array();

  /**
   * Creates an instance of Session.
   * @param {Home} home
   * @memberof Session
   */
  constructor(private home: Home) {
    super();
  }

  /**
   * Easily add new process to the session
   *
   * @param {cluster.Worker} worker
   * @memberof Session
   */
  public add(worker: cluster.Worker): cluster.Worker {
    // Add IPC listners
    worker.on("message", msg => {
      switch (msg.type) {
        case "hold":
          // Put a hold on these streams
          worker.send({
            type: msg.type,
            umid: msg.umid,
            lock: Locker.hold(msg.streams)
          });
          break;
        case "release":
          // Release these streams
          worker.send({
            type: msg.type,
            umid: msg.umid,
            release: Locker.release(msg.streams)
          });
          break;
        case "neighbour":
          // Update Master Home
          ActiveLogger.trace(msg, "Master Neighbour Update");

          // Tell Workers about their new neighbour
          this.shout("neighbour", msg);

          // Update Neighbour
          this.home.setNeighbours(false, msg.left, msg.right);
          break;
        case "hybrid":
          // Tell Workers to rebroadcast to the hybrid connected nodes
          this.shout("hybrid", msg);
          break;
        case "reload":
          // Tell Workers to reload options
          ActiveLogger.info("Master : Reload Request");
          this.reload();
          break;
        case "rebase":
          // Somehow tell the maintaince to check now
          this.emit("rebase");
          break;
        default:
          ActiveLogger.trace(msg, "Master -> Unknown IPC call");
          break;
      }
    });
    // Add to Reference
    this.workers.push(worker);

    // Return back worker
    return worker;
  }

  /**
   * Reload Network Options
   *
   * @memberof Session
   */
  public reload(): void {
    // Wait for reload solution
    setTimeout(() => {
      // Reload Neighbourhood into Master
      ActiveOptions.extendConfig()
        .then(config => {
          if (config.neighbourhood) {
            ActiveLogger.debug(config.neighbourhood, "Reset Request");

            // Reference would have changed
            Home.reference = this.home.reference = ActiveCrypto.Hash.getHash(
              this.home.getAddress().host +
                this.home.getAddress().port +
                ActiveOptions.get<string>("network", ""),
              "sha1"
            );

            // Reset Network
            this.home.neighbourhood.reset(config.neighbourhood);

            this.shout("reload", {});
            setTimeout(() => {
              this.emit("reorder");
            }, 3500);
          }
        })
        .catch(e => {
          ActiveLogger.info(e, "Failed to reload Neighbourhood");
        });
    }, 1000);
  }

  /**
   * Send a message to all the child processes (Workers)
   * Master shouts and workers moan
   *
   * @param {string} type
   * @param {*} data
   * @memberof Session
   */
  public shout(type: string, data: any): void {
    // Add type to data
    data.type = type;

    // Shout it to all the workers
    let i = this.workers.length;
    while (i--) {
      if (this.workers[i].isConnected() && !this.workers[i].isDead()) {
        this.workers[i].send(data);
      }
    }
  }
}
