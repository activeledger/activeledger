import * as http from "http";
import * as url from "url";
import * as querystring from "querystring";
import { ActiveLogger } from "@activeledger/activelogger";

export interface IActiveHttpIncoming {
  url: string[];
  query?: any;
  body?: any;
}

export class ActiveHttpd {
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
   * @memberof ActiveHttpd
   */
  private server: http.Server;

  /**
   * Route Handler
   *
   * @private
   * @type {*}
   * @memberof ActiveHttpd
   */
  private routes: any = [];

  /**
   * Define Route
   *
   * @param {string} url
   * @param {Function} handler
   * @memberof ActiveHttpd
   */
  public use(url: string, method: string, handler: Function) {
    // Add to routes
    this.routes.push({
      path: url.split("/").filter(url => url),
      method,
      handler
    });
  }

  /**
   * Start Server
   *
   * @param {number} port
   * @memberof ActiveHttpd
   */
  public listen(port: number) {
    // Get Local Reference
    let httpd: ActiveHttpd = this;

    // Create Server
    this.server = http.createServer();

    // Bind to request event
    this.server.on("request", async function(
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) {
      ActiveLogger.info(`${req.method} - ${req.url}`);

      const parsedUrl = url.parse(req.url as string);
      const pathSegments = (parsedUrl.pathname as string)
        .split("/")
        .filter(url => url);

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
          let data = Buffer.concat(body).toString();

          // Auto Parse if JSON
          if (req.headers["content-type"] == "application/json") {
            data = JSON.parse(data);
          }

          // Continue Processing
          httpd.processListen(
            {
              url: pathSegments,
              query: querystring.parse(parsedUrl.query as string),
              body: data
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
            query: querystring.parse(parsedUrl.query as string)
          },
          req,
          res
        );
      }
    });
    this.server.listen(port);
  }

  private async processListen(
    incoming: IActiveHttpIncoming,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // Parse the url

    // Get Path Handler
    let handler = this.findHandler(
      incoming.url.slice(0),
      req.method as string,
      this.routes
    );
    if (handler) {
      const data = await handler(incoming, req, res);
      if (data) {
        if (!res.statusCode) {
          res.statusCode = 200;
        }
        if (Buffer.isBuffer(data)) {
          res.write(data);
        } else {
          if (typeof data == "object") {
            res.setHeader("Content-type", ActiveHttpd.mimeType[".json"]);
            res.write(JSON.stringify(data));
          } else {
            res.write(data);
          }
        }
      } else {
        res.statusCode = 404;
        res.write("404");
      }
    } else {
      // 404
      res.statusCode = 404;
      res.write("404");
    }
    res.end();
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
   * @memberof ActiveHttpd
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
        // Should only have 1 handler so send the first (Will handle duplicates)
        // Unless there is a wildcard waiting for further paths
        // Reversed array loop so pop for last
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
   * @memberof ActiveHttpd
   */
  private selectSingleHandler(
    handlers: any[],
    position: number
  ): Function | null {
    // Multiple Matches
    if (handlers.length) {
      // If more than 1 element order * to the end
      if (handlers.length > 1) {
        handlers = handlers.sort((a,b) => {
          if (this.pathAstriskCount(a.path) > this.pathAstriskCount(b.path)) {
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
   * @memberof ActiveHttpd
   */
  private pathAstriskCount(path: string[]): number {
    let i = 0;
    path.some((element: string) => {
      if (element == "*") {
        i++;
        return true;
      }
      return false;
    });
    return i;
  }
}
