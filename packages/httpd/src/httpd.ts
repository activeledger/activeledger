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
//import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveGZip } from "@activeledger/activeutilities";
import { App, HttpResponse, TemplatedApp, us_listen_socket, us_listen_socket_close } from "uWebSockets.js";

export interface IActiveHttpResponse extends HttpResponse { }

/**
 * Interface for exposing processed request data to the endpoints
 *
 * @export
 * @interface IActiveHttpIncoming
 */
export interface IActiveHttpIncoming {
  url: string[];
  ip: IActiveHttpIp;
  query?: any;
  body?: any;
}

/**
 * Remote IP Details (Including Proxy)
 *
 * @export
 * @interface IActiveHttpIp
 */
export interface IActiveHttpIp {
  remote: string;
  proxy?: string;
}

/**
 * Lighter Dynamic Routing HTTP Server
 *
 * @export
 * @class ActiveHttpd
 */
export class ActiveHttpd {
  /**
   * Holds underlying socket
   *
   * @private
   * @type {us_listen_socket}
   */
  private listenSocket: us_listen_socket | null;

  /**
   * Mime Map
   *
   * @static
   * @type {*}
   */
  public static mimeType: any = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ttf": "aplication/font-sfnt",
    ".woff": "font/woff",
  };

  /**
   * HTTP Server
   *
   * @private
   * @type {http.Server}
   */
  private server: TemplatedApp;

  /**
   * Route Handler
   *
   * @private
   * @type {*}
   */
  private routes: any = [];

  /**
   * Compiled route Handler
   */
  private compiled: any = {};

  /**
   * Creates an instance of ActiveHttpd. CORS is always allowed - see
   * writeResponse() - there is no per-instance opt-out.
   */
  constructor() { }

  /**
   * Define Route
   *
   * @param {string} url
   * @param {Function} handler
   */
  public use(url: string, method: string, handler: Function) {
    // Add to routes
    let path = url == "/" ? [url] : url.split("/").filter((url) => url);
    this.routes.push({
      path,
      pac: this.pathAstriskCount(path),
      method,
      handler,
    });
  }

  /**
   * Compile routes for faster processing
   *
   */
  private compile() {
    // Reset
    this.compiled = {};

    // Group by method
    this.routes.forEach((route: any) => {
      (this.compiled[route.method] = this.compiled[route.method] || []).push(route);
    });
  }

  /**
   * Start Server
   *
   * @param {number} port
   * @param {boolean} [log=false]
   */
  public listen(port: number, log: boolean = false) {
    this.compile();
    // Get Local Reference
    let httpd: ActiveHttpd = this;

    this.server = App();

    this.server.any("/*", async (res, req) => {
      /* Can't return or yield from here without responding or attaching an abort handler */
      res.onAborted(() => {
        res.writable = false;
      });
      res.writable = true;

      const headers = {
        "Accept-Encoding": req.getHeader("accept-encoding"),
        "X-Activeledger": req.getHeader("x-activeledger"),
        "x-activeledger-encrypt": req.getHeader("x-activeledger-encrypt"),
        "content-encoding": req.getHeader("content-encoding"),
        "X-Bundle": req.getHeader("x-bundle"),
        "Content-Length": req.getHeader("content-length"),
        "Last-Event-ID": req.getHeader("last-event-id"),
      };

      const method = req.getMethod().toUpperCase();
      const rawQuery = req.getQuery();
      const query = rawQuery
        ? Object.fromEntries(new URLSearchParams(rawQuery).entries())
        : {};
      const url2 = req.getUrl();
      const path = url2.split("?")[0];

      const remoteAddress = res.getProxiedRemoteAddressAsText().byteLength ? res.getProxiedRemoteAddressAsText() : res.getRemoteAddressAsText();
      let ipFrom = Buffer.from(remoteAddress).toString();

      const pathSegments = (path as string)
        .split("/")
        .filter((url) => url);

      // Setup Default
      if (!pathSegments.length) {
        pathSegments.push("/");
      }

      if (method === "POST" || method === "PUT") {
        // Read from Buffer
        let body = await this.readBuffer(res);

        // gzipped?
        // Sometimes internal transactions fail to be decompressed
        // the header shouldn't be missing but added magic number check as a back
        // all internal transactions are supposed to be compressed failsafe check for when header isn't available?
        if (
          headers["content-encoding"] == "gzip" ||
          (body[0] == 0x1f && body[1] == 0x8b)
        ) {
          try {
            body = await ActiveGZip.ungzip(body);
          } catch (e) {
            // Just incase the magic number still invalid gzip
            // capture the "incorrect header check" -3 Z_DATA_ERROR and continue
            // with the original non-gzip compliant data
          }
        }
        body = JSON.parse(body.toString());
        httpd.processListen(
          {
            url: pathSegments,
            query,
            body,
            ip: { remote: ipFrom },
          },
          {
            headers,
            method,
            url: url2,
            connection: {
              remoteAddress: ipFrom,
            },
          },
          res
        );
      } else {
        httpd.processListen(
          {
            url: pathSegments,
            query,
            body: "",
            ip: { remote: ipFrom },
          },
          {
            headers,
            method,
            url: url2,
            connection: {
              remoteAddress: ipFrom,
            },
          },
          res
        );
      }
    });

    // Note: uWebSockets.js uses SO_REUSEPORT by default, which allows multiple instances
    // to bind to the same port. Instance locking is handled externally.
    this.server.listen(port, (token: us_listen_socket) => {
      this.listenSocket = token;
    });

  }


  public shutdown(): void {
    if (this.listenSocket) {
      // Close the listen socket
      us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;

      // Only have a a short while before sigkill
      // Lets try let them finish up then close the app before sigkill can happen
      setTimeout(() => {
        this.server.close();
        process.exit(0);
      }, 1300);
    }
  }

  private readBuffer(res: HttpResponse): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      /* Register data cb */
      res.onData((ab, isLast) => {
        if (res.aborted) {
          reject(new Error("Request aborted"));
          return;
        }

        // CRITICAL: Copy the data synchronously now, every return of onData neuters the ArrayBuffer
        if (ab.byteLength > 0) {
          const buffer = Buffer.allocUnsafe(ab.byteLength);
          buffer.set(new Uint8Array(ab));
          chunks.push(buffer);
        }

        if (isLast) {
          resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
        }
      });
    });
  }

  /**
   * Process Request now we have header and maybe the body
   *
   * @private
   * @param {IActiveHttpIncoming} incoming
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  private async processListen(
    incoming: IActiveHttpIncoming,
    req: {
      headers: {
        [index: string]: string;
      };
      method: string;
      url: string;
      connection: {
        remoteAddress: string;
      };
    },
    res: HttpResponse
  ) {
    // Get Path Handler
    let handler = this.findHandler(
      incoming.url.slice(0),
      req.method,
      this.compiled[req.method] || []
    );
    if (handler) {
      try {
        // Run the call handler
        const data = await handler(incoming, req, res);
        // If the headers have been sent handler took control
        if (data) {
          // Handler returns handled means its writing directly
          if (data == "handled") {
            return;
          }
          // if (!res.statusCode) {
          //   res.statusCode = 200;
          // }
          // if (Buffer.isBuffer(data)) {
          //   res.write(data);
          // } else {
          //   this.writeAsHttpData(data, res);
          // }
          // res.end();
          //this.writeResponse(res, 200, { "Access-Control-Allow-Origin": req.headers["origin"] }, data);

          if (data.mime) {
            this.writeResponse(res, 200, { "Content-Type": data.mime }, data.data);
          } else {
            this.writeResponse(res, 200, {}, data);
          }
        } else {
          this.writeResponse(res, 404, {}, "");
        }
      } catch (error) {
        // Defined error or default to internal server error
        //ActiveLogger.error(error);
        // res.statusCode = error.status || error.statusCode || 500;
        // this.writeAsHttpData(error, res);
        this.writeResponse(
          res,
          error.status || error.statusCode || 500,
          {},
          error
        );

        //res.end();
      }
    } else {
      // 404
      this.writeResponse(res, 404, {}, "");
    }
  }

  /**
   * Write the data correctly for the response
   *
   * @private
   * @param {*} data
   * @param {http.ServerResponse} res
   */
  // private writeAsHttpData(data: any, res: Socket) {
  //   if (typeof data == "object") {
  //     res.setHeader("Content-type", ActiveHttpd.mimeType[".json"]);
  //     res.write(JSON.stringify(data));
  //   } else {
  //     res.write(data);
  //   }
  // }

  /**
   * Find the right handler for the path
   *
   * @private
   * @param {string[]} path
   * @param {string} method
   * @param {any[]} routes
   * @param {number} [position=0]
   * @returns {(Function | null)}
   */
  private findHandler(
    path: string[],
    method: string,
    routes: any[],
    position: number = 0
  ): Function | null {
    // Current Path Position
    let search = path.shift();

    // Possible Handlers
    let handlers = [];

    // Loop all routes
    let i = routes.length;
    while (i--) {
      // Get Route
      let route = routes[i];

      // Method Test
      if (route.method == method || route.method == "ALL") {
        if (position >= route.path.length) {
          // Forever Nested route
          if (route.path[route.path.length - 1] == "**") {
            handlers.push(route);
          }
        } else {
          // Check to see if route is allowable
          if (
            route.path[position] == "*" ||
            route.path[position] == "**" ||
            route.path[position] == search
          ) {
            handlers.push(route);
          }
        }
      }
    }

    // Any matching handlers?
    if (handlers.length) {
      // If there is more paths we need the check them
      if (path.length) {
        return this.findHandler(path, method, handlers, ++position);
      } else {
        // Select the most relevant handler if multiple matches
        return this.selectSingleHandler(handlers, position);
      }
    } else {
      // 404
      return null;
    }
  }

  /**
   * Selects the most likely matched path
   *
   * @private
   * @param {any[]} handlers
   * @param {number} position
   * @returns {Function}
   */
  private selectSingleHandler(
    handlers: any[],
    position: number
  ): Function | null {
    // Multiple Matches

    if (handlers.length) {
      // If more than 1 element order * to the end
      if (handlers.length > 1) {
        handlers = handlers.sort((a, b) => {
          if (a.pac > b.pac) {
            return -1;
          }
          return 1;
        });
      }

      // Loop to find out which is exact match or further nested
      let i = handlers.length;
      while (i--) {
        if (handlers[i].path.length - 1 == position) {
          return handlers[i].handler as Function;
        }

        // Forever Nested?
        if (handlers[i].path[handlers[i].path.length - 1] == "**") {
          return handlers[i].handler as Function;
        }
      }
    }

    // 404
    return null;
  }

  /**
   * Find how meaning leading * in the path
   *
   * @private
   * @param {string[]} path
   * @returns {number}
   */
  private pathAstriskCount(path: string[]): number {
    let c = 0;
    for (let i = 0; i < path.length; i++) {
      const element = path[i];
      if (element == "*") {
        c++;
      } else if (element == "**") {
        c += 2; // Or just ++ will we ever have a ** clash to resolve?
      }
    }
    return c;
  }

  /**
   * IPv4 & IPv6 notation support
   *
   * @private
   * @param {string} ip
   * @returns {string}
   */
  private ipv46(ip: string): string {
    return ip.substr(0, 7) == "::ffff:" ? ip.substr(7) : ip;
  }

  /**
   * Write the response to the brwoser
   *
   * @private
   * @param {ServerResponse} res
   * @param {number} statusCode
   * @param {(string | Buffer)} content
   * @param {string} encoding
   */
  private async writeResponse(
    res: HttpResponse,
    statusCode: number,
    headers: { [key: string]: string },
    content: string | Buffer,
    encoding: string = ""
  ) {
    if (!res.writable) {
      return;
    }

    if (content) {
      if (encoding == "gzip") {
        content = await ActiveGZip.gzip(content);
      }
    }

    res.cork(() => {
      res.writeStatus(`${statusCode}`);
      res.writeHeader("Access-Control-Allow-Origin", "*");
      res.writeHeader("Access-Control-Allow-Methods", "GET, POST");
      res.writeHeader("Access-Control-Allow-Headers", "*");
      //res.writeHeader("X-Content-Type-Options", "nosniff");
      //res.writeHeader("X-Frame-Options", "DENY");
      //res.writeHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
      //res.writeHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");

      for (const header in headers) {
        res.writeHeader(header, headers[header]);
      }

      if (content) {
        if (!Buffer.isBuffer(content) && typeof content == "object") {
          content = JSON.stringify(content);
        }

        if (!headers["Content-Type"]) {
          //res.write(`Content-Type: application/json\r\n`);
          res.writeHeader("Content-Type", "application/json");
        }

        if (encoding == "gzip") {
          res.writeHeader("Content-Encoding", "gzip");
        }
        res.end(content);
        res.writable = false;
      }
    });
  }
}
