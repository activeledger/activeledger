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
import * as url from "url";
import * as querystring from "querystring";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveGZip } from "@activeledger/activeutilities";

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
    ".woff": "font/woff"
  };

  /**
   * HTTP Server
   *
   * @private
   * @type {http.Server}
   */
  private server: http.Server;

  /**
   * Route Handler
   *
   * @private
   * @type {*}
   */
  private routes: any = [];

  /**
   * Creates an instance of ActiveHttpd.
   * @param {boolean} [enableCORS=false]
   */
  constructor(private enableCORS: boolean = false) {}

  /**
   * Define Route
   *
   * @param {string} url
   * @param {Function} handler
   */
  public use(url: string, method: string, handler: Function) {
    // Add to routes
    let path = url == "/" ? [url] : url.split("/").filter(url => url);
    this.routes.push({
      path,
      pac: this.pathAstriskCount(path),
      method,
      handler
    });
  }

  /**
   * Start Server
   *
   * @param {number} port
   * @param {boolean} [log=false]
   */
  public listen(port: number, log: boolean = false) {
    // Get Local Reference
    let httpd: ActiveHttpd = this;

    // Create Server
    this.server = http.createServer();

    // Bind to request event
    this.server.on("request", async function(
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) {
      if (log) ActiveLogger.info(`${req.method} - ${req.url}`);

      const parsedUrl = url.parse(req.url as string);
      const pathSegments = (parsedUrl.pathname as string)
        .split("/")
        .filter(url => url);

      // Setup Default
      if (!pathSegments.length) {
        pathSegments.push("/");
      }

      // Press Remote IP
      const ip: IActiveHttpIp = {
        remote: httpd.ipv46(req.connection.remoteAddress as string)
      };

      // Has a proxy been involved
      if (req.headers["x-forwarded-for"]) {
        ip.proxy = ip.remote;
        ip.remote = httpd.ipv46(req.headers["x-forwarded-for"] as string);
      }

      // Capture POST data
      if (req.method == "POST" || req.method == "PUT") {
        // Holds the body
        let body: Buffer[] = [];

        // Reads body data
        req.on("data", chunk => {
          body.push(chunk);
        });

        // When read has compeleted continue
        req.on("end", async () => {
          // Combine Body Buffer
          let data: string;

          // Data Compression
          if (req.headers["content-encoding"] == "gzip") {
            // Decompress and get as string
            data = (await ActiveGZip.ungzip(Buffer.concat(body))).toString();
          } else {
            // Get string
            data = Buffer.concat(body).toString();
          }

          // Auto Parse if JSON
          if (req.headers["content-type"] == "application/json") {
            data = JSON.parse(data);
          }

          // Continue Processing
          httpd.processListen(
            {
              url: pathSegments,
              query: querystring.parse(parsedUrl.query as string),
              body: data,
              ip
            },
            req,
            res
          );
        });
      } else {
        // Continue Processing
        httpd.processListen(
          {
            url: pathSegments,
            query: querystring.parse(parsedUrl.query as string),
            ip
          },
          req,
          res
        );
      }
    });
    this.server.listen(port);
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
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // Get Path Handler
    let handler = this.findHandler(
      incoming.url.slice(0),
      req.method as string,
      this.routes
    );
    if (handler) {
      try {
        // Default Allow CORS
        if (this.enableCORS && req.headers["origin"]) {
          res.setHeader(
            "Access-Control-Allow-Origin",
            req.headers["origin"] as string
          );
        }
        // Run the call handler
        const data = await handler(incoming, req, res);
        // If the headers have been sent handler took control
        if (data) {
          // Handler returns handled means its writing directly
          if (data == "handled") {
            return;
          }
          if (!res.statusCode) {
            res.statusCode = 200;
          }
          if (Buffer.isBuffer(data)) {
            res.write(data);
          } else {
            this.writeAsHttpData(data, res);
          }
          res.end();
        } else {
          if (!res.statusCode) {
            res.statusCode = 404;
            res.write("404");
          }
          res.end();
        }
      } catch (error) {
        // Defined error or default to internal server error
        ActiveLogger.error(error);
        res.statusCode = error.status || error.statusCode || 500;
        this.writeAsHttpData(error, res);
        res.end();
      }
    } else {
      // 404
      res.statusCode = 404;
      res.write("404");
      res.end();
    }
  }

  /**
   * Write the data correctly for the response
   *
   * @private
   * @param {*} data
   * @param {http.ServerResponse} res
   */
  private writeAsHttpData(data: any, res: http.ServerResponse) {
    if (typeof data == "object") {
      res.setHeader("Content-type", ActiveHttpd.mimeType[".json"]);
      res.write(JSON.stringify(data));
    } else {
      res.write(data);
    }
  }

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
}
