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
import { RestBindings, Response, Request, param, get } from "@loopback/rest";
import { inject } from "@loopback/context";

export class EventController {
  constructor(
    @inject(RestBindings.Http.REQUEST) public request: Request,
    @inject(RestBindings.Http.RESPONSE) private response: Response
  ) {}

  /**
   * Subscribe to all events
   *
   * @returns {Promise<any>}
   * @memberof EventController
   */
  @get("/api/events", {
    responses: {
      "200": {
        description: "Subscribe to smart contract events",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  events(): Promise<any> {
    return new Promise((resolve, reject) => {
      // Make sure we have an array
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getEvents(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // Prepare data
        let prepare = {
          event: {
            name: change.doc.name,
            data: change.doc.data
          },
          phase: change.doc.phase,
          time: Date.now()
        };

        // Connection still open?
        if (this.response.writable) {
          // Write new event
          this.response.write(
            `id:${change.seq}\nevent: message\ndata:${JSON.stringify(prepare)}`
          );
          this.response.write("\n\n");
        } else {
          // End Server Side
          this.response.end();
          // End Heartbeat
          HeartBeat.Stop(heartBeat);
          reject("socket closed");
        }
      });
    });
  }

  /**
   * Subscribe to a specific smart contract events
   *
   * @param {string} contract
   * @returns {Promise<any>}
   * @memberof EventController
   */
  @get("/api/events/{contract}", {
    responses: {
      "200": {
        description: "Subscribe to a specific smart contract events",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  contractEvents(
    @param.path.string("contract") contract: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getEvents(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // This Contract?
        if (change.doc.contract === contract) {
          // Prepare data
          let prepare = {
            event: {
              name: change.doc.name,
              data: change.doc.data
            },
            phase: change.doc.phase,
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
   * Subscribe to a specific smart contracts specific event
   *
   * @param {string} contract
   * @param {string} event
   * @returns {Promise<any>}
   * @memberof EventController
   */
  @get("/api/events/{contract}/{event}", {
    responses: {
      "200": {
        description: "Subscribe to a specific smart contract specific event",
        content: { "text/event-stream": { schema: { type: "string" } } }
      }
    }
  })
  contractEventsFiltered(
    @param.path.string("contract") contract: string,
    @param.path.string("event") event: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.response.status(200).contentType("text/event-stream");

      // Start Heartbeat
      const heartBeat = HeartBeat.Start(this.response);

      // Listen for changes
      ActiveledgerDatasource.getEvents(
        this.request.header("Last-Event-ID") || "now"
      ).on("change", (change: any) => {
        // This Contract && This Event?
        if (change.doc.contract === contract && change.doc.name === event) {
          // Prepare data
          let prepare = {
            event: {
              name: change.doc.name,
              data: change.doc.data
            },
            phase: change.doc.phase,
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
