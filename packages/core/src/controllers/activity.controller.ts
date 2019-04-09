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

import { ActiveledgerDatasource } from "../datasources/activeledger";
import { HeartBeat } from "../heatbeat.service";
import {
  RestBindings,
  Response,
  Request,
  param,
  requestBody,
  get,
  post
} from "@loopback/rest";
import { inject } from "@loopback/context";

export class ActivityController {
  /**
   * Creates an instance of ActivityController.
   * That we can get the response object to write directly
   *
   * @param {Response} response
   * @memberof ActivityController
   */
  constructor(
    @inject(RestBindings.Http.REQUEST) public request: Request,
    @inject(RestBindings.Http.RESPONSE) private response: Response
  ) {}

  /**
   * Subscribes to all activity stream changes on the ledger
   *
   * @returns {Promise<any>}
   * @memberof ActivityController
   */
  @get("/api/activity/subscribe", {
    responses: {
      "200": {
        description: "Subscribe to all Activity Stream changes",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  subscribe(): Promise<any> {
    return new Promise((resolve, reject) => {
      // Make sure we have an array
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getChanges(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // Skip Restore Engine Changes
        // Skip any with a : (umid, volatile, stream)
        if (
          change.doc._id.indexOf(":") == -1 &&
          (!change.doc.$activeledger ||
            (change.doc.$activeledger &&
              !change.doc.$activeledger.delete &&
              !change.doc.$activeledger.rewrite))
        ) {
          // Prepare data
          let prepare = {
            event: "update",
            stream: change.doc,
            time: Date.now()
          };

          // Connection still open?
          if (this.response.writable) {
            // Write new event
            this.response.write(
              `id:${change.seq}\nevent: message\ndata:${JSON.stringify(
                prepare
              )}`
            );
            this.response.write("\n\n");
          } else {
            // End Server Side
            this.response.end();
            // End Heartbeat
            HeartBeat.Stop(heartBeat);
            reject("socket closed");
          }
        }
      });
    });
  }

  /**
   * Subscribe to specific activity stream changes
   *
   * @param {string} stream
   * @returns {Promise<any>}
   * @memberof ActivityController
   */
  @get("/api/activity/subscribe/{stream}", {
    responses: {
      "200": {
        description: "Subscribe to a specific Activity Stream changes",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  subscribeFilter(@param.path.string("stream") stream: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getChanges(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // Is this change for our document?
        if (change.doc._id === stream) {
          // Prepare data
          let prepare = {
            event: "update",
            stream: change.doc,
            time: Date.now()
          };

          // Connection still open?
          if (this.response.writable) {
            // Write new event
            this.response.write(
              `id:${change.seq}\nevent: message\ndata:${JSON.stringify(
                prepare
              )}`
            );
            this.response.write("\n\n");
          } else {
            // End Server Side
            this.response.end();
            // End Heartbeat
            HeartBeat.Stop(heartBeat);
            reject("socket closed");
          }
        }
      });
    });
  }

  /**
   * Subscribe to multiple activity streams changes
   *
   * @param {string[]} streams
   * @returns {Promise<any>}
   * @memberof ActivityController
   */
  @post("/api/activity/subscribe", {
    responses: {
      "200": {
        description: "Subscribe to a specific Activity Streams changes",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  subscribeMultipleFilter(@requestBody() streams: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getChanges(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // Is this change for our documents?
        if (streams.indexOf(change.doc._id) !== -1) {
          // Prepare data
          let prepare = {
            event: "update",
            stream: change.doc,
            time: Date.now()
          };

          // Connection still open?
          if (this.response.writable) {
            // Write new event
            this.response.write(
              `id:${change.seq}\nevent: message\ndata:${JSON.stringify(
                prepare
              )}`
            );
            this.response.write("\n\n");
          } else {
            // End Server Side
            this.response.end();
            // End Heartbeat
            HeartBeat.Stop(heartBeat);
            reject("socket closed");
          }
        }
      });
    });
  }
}
