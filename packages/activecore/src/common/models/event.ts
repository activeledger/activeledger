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

import * as fs from "fs";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Model } from "@mean-expert/model";
import { Model as LBModel } from "../../fireloop";
import { PassThrough } from "stream";
/**
 * @module Event
 * @description
 * Write a useful Event Model description.
 * Register hooks and remote methods within the
 * Model Decorator
 **/
@Model({
  hooks: {},
  remotes: {
    subscribe: {
      returns: { arg: "changes", type: "ReadableStream", json: true },
      http: { path: "/", verb: "get" }
    },
    subscribeContract: {
      accepts: { arg: "contract", type: "string", required: true },
      returns: { arg: "changes", type: "ReadableStream", json: true },
      http: { path: "/:contract", verb: "get" }
    },
    subscribeContractFilter: {
      accepts: [
        { arg: "contract", type: "string", required: true },
        { arg: "event", type: "string", required: true }
      ],
      returns: { arg: "changes", type: "ReadableStream", json: true },
      http: { path: "/:contract/:event", verb: "get" }
    }
  }
})
export default class Event {
  /**
   * Feed Follower
   *
   * @private
   * @type {*}
   * @memberof Event
   */
  private feed: any;

  /**
   * Who has subcribed to what stream
   *
   * @private
   * @type {{ [index: string]: any }}
   * @memberof Event
   */
  private subscribers: { [index: string]: any } = {};

  /**
   * Creates an instance of Event.
   * @param {LBModel} model
   * @memberof Event
   */
  constructor(public model: LBModel) {
    // Get Config from global
    let config = ActiveOptions.fetch(false);

    // Self Hosted?
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      // Get Database
      let db = ActiveOptions.get<any>("db", {});

      // Set Url
      db.url = "http://127.0.0.1:" + db.selfhost.port;

      // We can also update the path to override the default couch install
      db.path = db.selfhost.dir || "./.ds";

      // Set Database
      ActiveOptions.set("db", db);
    }

    // Get Follow Object
    let follow = require("cloudant-follow");

    // Create Feed Connection
    this.feed = new follow.Feed({
      db: config.db.url + "/" + config.db.event,
      include_docs: true
    });

    // Bind On Change Event
    // Manage on feed notifcation to subsribers
    this.feed.on("change", (change: any) => {
      // Prepare data
      let prepare = {
        event: {
          name: change.doc.name,
          data: change.doc.data
        },
        phase: change.doc.phase,
        time: Date.now()
      };

      // All Contract Events
      if (this.subscribers[change.doc.contract]) {
        // Send to all filter subscribers first
        let i = this.subscribers[change.doc.contract].length;
        while (i--) {
          this.subscribers[change.doc.contract][i].write(prepare);
        }
      }

      // This Contract Events
      if (this.subscribers[change.doc.contract + "-" + change.doc.name]) {
        // Send to all filter subscribers first
        let i = this.subscribers[change.doc.contract + "-" + change.doc.name]
          .length;
        while (i--) {
          this.subscribers[change.doc.contract + "-" + change.doc.name][
            i
          ].write(prepare);
        }
      }

      // Now send to all subcribers wanting all events
      if (this.subscribers["all"]) {
        let i = this.subscribers["all"].length;
        while (i--) {
          this.subscribers["all"][i].write(prepare);
        }
      }
    });

    // bind On Error Event
    this.feed.on("error", (error: any) => {});

    // Start Feeding
    this.feed.follow();
  }

  /**
   * Register for all stream changes
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Event
   */
  subscribe(next: Function): void {
    // Make sure we have an array
    if (!this.subscribers["all"]) this.subscribers["all"] = [];

    // Now to setup the readable stream
    let passthrough = new PassThrough({ objectMode: true });

    // Add to subscriber
    this.subscribers["all"].push(passthrough);

    // Return to Client
    next(null, passthrough);
  }

  /**
   * Register to filtered stream changes
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Event
   */
  subscribeContract(stream: string, next: Function): void {
    // Make sure we have an array
    if (!this.subscribers[stream]) this.subscribers[stream] = [];

    // Now to setup the readable stream
    let passthrough = new PassThrough({ objectMode: true });

    // Add to subscriber
    this.subscribers[stream].push(passthrough);

    // Return to Client
    next(null, passthrough);
  }

  /**
   * Register to multiple filtered stream changes
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Event
   */
  subscribeContractFilter(stream: string, event: string, next: Function): void {
    // Make sure we have an array
    if (!this.subscribers[`${stream}-${event}`])
      this.subscribers[`${stream}-${event}`] = [];

    // Now to setup the readable stream
    let passthrough = new PassThrough({ objectMode: true });

    // Add to subscriber
    this.subscribers[`${stream}-${event}`].push(passthrough);

    // Return to Client
    next(null, passthrough);
  }
}
