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
import { HeartBeat } from "./../heatbeat";

/**
 * Skip Restore Engine Changes
 * Skip any with a : (umid, volatile, stream)
 *
 * @param {*} change
 * @returns
 */
function dontSkip(change: any) {
  return (
    change.doc._id.indexOf(":") == -1 &&
    (!change.doc.$activeledger ||
      (change.doc.$activeledger &&
        !change.doc.$activeledger.delete &&
        !change.doc.$activeledger.rewrite))
  );
}

/**
 * Creates SSE for activity stream changes
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function allActivityStreams(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Let httpd know we are on the case!
    resolve("handled");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    // Listen for changes
    ActiveledgerDatasource.getChanges(
      (req.headers["Last-Event-ID"] as string) || "now"
    ).on("change", (change: any) => {
      if (dontSkip(change)) {
        // Prepare data
        let prepare = {
          event: "update",
          stream: change.doc,
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
 * Creates SSE for a specific activity stream change
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function specificActivityStream(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Let httpd know we are on the case!
    resolve("handled");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    // Listen for changes
    ActiveledgerDatasource.getChanges(
      (req.headers["Last-Event-ID"] as string) || "now"
    ).on("change", (change: any) => {
      if (dontSkip(change)) {
        // Is this change for our document?
        if (change.doc._id === incoming.url[3]) {
          // Prepare data
          let prepare = {
            event: "update",
            stream: change.doc,
            time: Date.now()
          };

          // Connection still open?
          if (res.writable) {
            // Write new event
            res.write(
              `id:${change.seq}\nevent: message\ndata:${JSON.stringify(
                prepare
              )}`
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
      }
    });
  });
}

/**
 * Creates SSE for specific multiple activity stream changes
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<string>}
 */
export async function multipleActivityStreams(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Make sure we have an array
    res.statusCode = 200;

    // Set Header
    res.setHeader("Content-type", "text/event-stream");

    // Let httpd know we are on the case!
    resolve("handled");

    // Start Heartbeat
    const heartBeat = HeartBeat.Start(res);

    // Listen for changes
    ActiveledgerDatasource.getChanges(
      (req.headers["Last-Event-ID"] as string) || "now"
    ).on("change", (change: any) => {
      // Skip Restore Engine Changes
      // Skip any with a : (umid, volatile, stream)
      if (dontSkip(change)) {
        // Is this change for our documents?
        if (incoming.body.indexOf(change.doc._id) !== -1) {
          // Prepare data
          let prepare = {
            event: "update",
            stream: change.doc,
            time: Date.now()
          };

          // Connection still open?
          if (res.writable) {
            // Write new event
            res.write(
              `id:${change.seq}\nevent: message\ndata:${JSON.stringify(
                prepare
              )}`
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
      }
    });
  });
}
