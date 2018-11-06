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

/**
 * Simple HTTP Request Object
 *
 * @export
 * @class ActiveRequest
 */
export class ActiveRequest {
  /**
   * Send HTTP(S) GET/POST JSON Request
   *
   * @static
   * @param {string} reqUrl
   * @param {string} type
   * @param {string[]} [header]
   * @param {*} [data]
   * @returns {Promise<any>}
   * @memberof ActiveRequest
   */
  public static send(
    reqUrl: string,
    type: string,
    header?: string[],
    data?: any
  ): Promise<any> {
    // return new pending promise
    return new Promise((resolve, reject) => {
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
        headers: {}
      };

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
      if (data && options.method == "POST") {
        // convert data to string
        data = JSON.stringify(data);

        (options.headers as any)["Content-Type"] = "application/json";
        (options.headers as any)["Content-Length"] = data.length;
      }

      // Build Request Object
      const request: http.ClientRequest = (lib as any).request(
        options,
        (response: http.IncomingMessage) => {
          // handle http errors
          if (
            response.statusCode &&
            (response.statusCode < 200 || response.statusCode > 299)
          ) {
            reject(new Error("URL Request Failed" + response.statusCode));
          }

          // Hold response data
          const body: Buffer[] = [];

          // On data recieved add to the array
          response.on("data", chunk => body.push(chunk));

          // Completed join the data array and parse as JSON
          response.on("end", () => {
            if (body.length) {
              // Add to "data" to mimic old lib
              try {
                resolve({
                  data: JSON.parse(body.toString())
                });
              } catch (error) {
                reject(new Error("Failed to parse body"));
              }
            } else {
              resolve();
            }
          });
        }
      );
      // handle connection errors of the request
      request.on("error", err => reject(err));

      // Write data if sending
      if (data && options.method == "POST") {
        // Write Data
        request.write(data);
      }

      // End Request
      request.end();

      // Handle timeout (May not need)
      //   request.setTimeout(30000, () => {
      //     request.abort();
      //   });
    });
  }
}
