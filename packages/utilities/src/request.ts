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

import * as http from "http";
import * as https from "https";
import * as url from "url";
import { ActiveGZip } from "./gzip";
import { Dispatcher, request, setGlobalDispatcher, Agent } from "undici";

/**
 * Returned HTTP Resonse data
 *
 * @interface IHTTPResponse
 */
interface IHTTPResponse {
  //raw: string;
  data: unknown;
}

setGlobalDispatcher(
  new Agent({
    connect: {
      rejectUnauthorized: false,
    },
  })
);

/**
 * Simple HTTP Request Object
 *
 * @export
 * @class ActiveRequest
 */
export class ActiveRequest {
  public static async send(
    reqUrl: string,
    type: string,
    header?: string[],
    data?: any,
    enableGZip: boolean = false,
    timeout: number = 300 // undici default
  ): Promise<IHTTPResponse> {
    //enableGZip = false
    timeout = timeout * 1000;
    const options: Omit<Dispatcher.RequestOptions, "path"> = {
      method: type.toUpperCase() as any, // Fix
      headers: {},
      headersTimeout: timeout,
      bodyTimeout: timeout,
    };

    // Compressable?
    if (enableGZip) {
      (options.headers as any)["Accept-Encoding"] = "gzip";
    }

    let bundled = false;

    // Add Headers
    if (header) {
      for (let i = header.length; i--; ) {
        // Split Headers
        const [name, value] = header[i].split(":");
        // Asign to Header
        (options.headers as any)[name] = value;
        if (!bundled && name == "X-Bundle") {
          bundled = true;
        }
      }
    }

    // Manage Data
    if (data && (options.method == "POST" || options.method == "PUT")) {
      // convert data to string if object
      if (typeof data === "object") {
        data = Buffer.from(JSON.stringify(data), "utf8");
        (options.headers as any)["content-type"] = "application/json";
      }

      // Compressable?
      if (enableGZip) {
        // Compress
        data = await ActiveGZip.gzip(data);
        (options.headers as any)["content-encoding"] = "gzip";
        // options.headers.push("Content-Encoding: gzip")
        // options.headers.push("Content-Encoding-2: gzip")
      }

      // Additional Post headers
      //(options.headers as any)["Content-Length"] = data.length;
      //(options.headers as any)["Content-Length-x2"] = data.length;

      options.body = data;
    }

    try {
      const { headers, body } = await request(reqUrl, options);

      try {
        // Back Compat gzip support
        if (headers["content-encoding"] === "gzip") {
          const data = await ActiveGZip.ungzip(
            Buffer.from(await body.arrayBuffer())
          );
          return { data: JSON.parse(data.toString()) };
        } else {
          return { data: await body.json() };
        }
      } catch (e) {
        return { data: null };
      }
    } catch (e) {
      if (!bundled) {
        return { data: null };
      } else {
        // Circular Dependency issue
        return { data: null };
      }
    }
  }

  /**
   * Send HTTP(S) GET/POST JSON Request
   *
   * @static
   * @param {string} reqUrl
   * @param {string} type
   * @param {string[]} [header]
   * @param {*} [data]
   * @param {boolean} [enableGZip=false]
   * @returns {Promise<any>}
   */
  public static send2(
    reqUrl: string,
    type: string,
    header?: string[],
    data?: any,
    enableGZip: boolean = false
  ): Promise<any> {
    // return new pending promise
    return new Promise(async (resolve, reject) => {
      // Parse URL
      const urlParsed = url.parse(reqUrl, false);

      // select http or https module, depending on reqested url
      const lib = reqUrl.startsWith("https") ? https : http;

      // Build Base Options
      let options: https.RequestOptions = {
        hostname: urlParsed.hostname,
        path: urlParsed.path,
        port: urlParsed.port,
        method: type.toUpperCase(),
        headers: {},
        rejectUnauthorized: false,
      };

      // Compressable?
      if (enableGZip) {
        (options.headers as any)["Accept-Encoding"] = "gzip";
      }

      // Add Headers
      if (header) {
        let i = header.length;
        while (i--) {
          // Split Headers
          const [name, value] = header[i].split(":");
          // Asign to Header
          (options.headers as any)[name] = value;
        }
      }

      // Manage Data
      if (data && (options.method == "POST" || options.method == "PUT")) {
        // convert data to string if object
        if (typeof data === "object") {
          data = Buffer.from(JSON.stringify(data), "utf8");
          (options.headers as any)["Content-Type"] = "application/json";
        }

        // Compressable?
        if (enableGZip) {
          // Compress
          data = await ActiveGZip.gzip(data);
          (options.headers as any)["Content-Encoding"] = "gzip";
        }

        // Additional Post headers
        (options.headers as any)["Content-Length"] = data.length;
      }

      // Build Request Object
      const request: http.ClientRequest = (lib as any).request(
        options,
        (response: http.IncomingMessage) => {
          // Hold response data
          const body: Buffer[] = [];

          // Skipable heartbeats
          const heartBeats = ["\0", "\n"];

          // On data recieved add to the array
          response.on("data", (chunk: Buffer) => {
            // Skip Heartbeats
            if (chunk.length > 1 || !heartBeats.includes(chunk.toString())) {
              body.push(chunk);
            }
          });

          // Completed join the data array and parse as JSON
          response.on("end", async () => {
            if (body.length) {
              // Add to "data" to mimic old lib
              try {
                const bodyBuffer = Buffer.concat(body);
                // Gziped?
                let gdata;
                if (response.headers["content-encoding"] == "gzip") {
                  gdata = await ActiveGZip.ungzip(bodyBuffer);
                }

                // Raw Response Data
                let raw = (gdata || bodyBuffer).toString();

                if (
                  response.statusCode &&
                  (response.statusCode < 200 || response.statusCode > 299)
                ) {
                  throw {
                    name: "ActiveError",
                    message: `URL Request Failed : ${reqUrl} - ${response.statusCode}`,
                    body: raw,
                    stack: new Error().stack,
                  };
                }

                // JSON response?
                if (
                  response.headers["content-type"]?.indexOf(
                    "application/json"
                  ) !== -1
                ) {
                  return resolve({
                    raw,
                    data: JSON.parse(raw),
                  });
                } else {
                  return resolve({
                    raw,
                  });
                }
              } catch (error) {
                if (error.name && error.message) {
                  return reject(error);
                } else {
                  return reject(new Error("Failed to parse body"));
                }
              }
            } else {
              // Error may not have a body
              if (
                response.statusCode &&
                (response.statusCode < 200 || response.statusCode > 299)
              ) {
                return reject({
                  name: "ActiveError",
                  message: `URL Request Failed : ${reqUrl} - ${response.statusCode}`,
                  body: "",
                  stack: new Error().stack,
                });
              }
              return resolve({ raw: "" });
            }
          });
        }
      );
      // handle connection errors of the request
      request.on("error", (err: NodeJS.ErrnoException) => {
        if (request.reusedSocket && err.code === "ECONNRESET") {
          // Resend
          this.send(reqUrl, type, header, data, enableGZip)
            .then((r) => resolve(r))
            .catch((e) => reject(e));
        } else {
          reject(err);
        }
      });

      // Write data if sending
      if (data && (options.method == "POST" || options.method == "PUT")) {
        // Write Data
        request.write(data);
      }

      // End Request
      request.end();
    });
  }
}
