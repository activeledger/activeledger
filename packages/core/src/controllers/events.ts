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
import { IncomingMessage, ServerResponse } from "http";
import { IActiveHttpIncoming } from "@activeledger/httpd";
import { ActiveledgerDatasource } from "./../datasource";
import { HeartBeat } from "../heartbeat";

/**
 * Create SSE for all the events created by contracts
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function events(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    resolve("handled");

    // Listen for changes
    ActiveledgerDatasource.getEvents(
      (req.headers["Last-Event-ID"] as string) || "now"
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
      if (res.writable) {
        // Write new event
        res.write(
          `id:${change.seq}\nevent: message\ndata:${JSON.stringify(prepare)}`
        );
        res.write("\n\n");
      } else {
        // End Server Side
        res.end();
        // End Heartbeat
        HeartBeat.Stop(heartBeat);
        reject("socket closed");
      }
    });
  });
}

/**
 * Create SSE for all the events created by a specific contract
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function contractEvents(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    resolve("handled");

    // Listen for changes
    ActiveledgerDatasource.getEvents(
      (req.headers["Last-Event-ID"] as string) || "now"
    ).on("change", (change: any) => {
      // This Contract?
      if (change.doc.contract === incoming.url[2]) {
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
        if (res.writable) {
          // Write new event
          res.write(
            `id:${change.seq}\nevent: message\ndata:${JSON.stringify(prepare)}`
          );
          res.write("\n\n");
        } else {
          // End Server Side
          res.end();
          // End Heartbeat
          HeartBeat.Stop(heartBeat);
          reject("socket closed");
        }
      }
    });
  });
}

/**
 * Create SSE for specific event for a specific contract
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function contractSpecificEvent(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    resolve("handled");

    // Listen for changes
    ActiveledgerDatasource.getEvents(
      (req.headers["Last-Event-ID"] as string) || "now"
    ).on("change", (change: any) => {
      // This Contract && This Event?
      if (
        change.doc.contract === incoming.body[2] &&
        change.doc.name === incoming.body[3]
      ) {
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
        if (res.writable) {
          // Write new event
          res.write(
            `id:${change.seq}\nevent: message\ndata:${JSON.stringify(prepare)}`
          );
          res.write("\n\n");
        } else {
          // End Server Side
          res.end();
          // End Heartbeat
          HeartBeat.Stop(heartBeat);
          reject("socket closed");
        }
      }
    });
  });
}
