import * as http from "http";
import * as url from "url";
import { ActiveLogger } from "@activeledger/activelogger";

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
  private routes: any = {};

  /**
   * Define Route
   *
   * @param {string} url
   * @param {Function} handler
   * @memberof ActiveHttpd
   */
  public use(url: string, handler: Function) {
    this.routes[url] = handler;
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
      // Parse the url
      const parsedUrl = url.parse(req.url as string);
      const pathSegments = (parsedUrl.pathname as string)
        .split("/")
        .filter(url => url);

      // How to manage wildcard nested routes

      // Do we have this route defined
      if (httpd.routes[pathSegments[0] || "/"]) {
        const data = await httpd.routes[pathSegments[0] || "/"](req, res);
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
    });
    this.server.listen(port);
  }
}
