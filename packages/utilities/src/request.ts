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
      const { headers, body, statusCode } = await request(reqUrl, options);

      // Cannot do this just yet, deposit wants to treat 404 as 200 (and maybe other areas)
      // if (statusCode < 200 || statusCode > 299) {
      //   const errorBody = await body.text();
      //   throw {
      //     name: "ActiveError",
      //     message: `URL Request Failed : ${reqUrl} - ${statusCode}`,
      //     body: errorBody,
      //     stack: new Error().stack,
      //   };
      // }

      try {
        // Back Compat gzip support
        if (headers["content-encoding"]?.includes("gzip")) {
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
}
