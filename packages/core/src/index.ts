import { readFileSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { ActiveHttpd, IActiveHttpIncoming } from "./httpd";
import { ActiveledgerDatasource } from "./datasource";
import { HeartBeat } from "./heatbeat";

// Initalise CLI Options
ActiveOptions.init();

// Parse Config
ActiveOptions.parseConfig();

// Basic check for database and config
if (ActiveOptions.get("db", false)) {
  // Extend Config
  ActiveOptions.extendConfig();

  // Start The Application
  // Create Light Server
  let http = new ActiveHttpd();

  // Index
  http.use("/", "GET", () => {
    return "Welcome to Activeledger Core";
  });

  // Activity
  http.use(
    "/api/activity/subscribe/*",
    "GET",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

        // Listen for changes
        ActiveledgerDatasource.getChanges(
          (req.headers["Last-Event-ID"] as string) || "now"
        ).on("change", (change: any) => {
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
        });
      });
    }
  );

  http.use(
    "/api/activity/subscribe",
    "GET",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

        // Listen for changes
        ActiveledgerDatasource.getChanges(
          (req.headers["Last-Event-ID"] as string) || "now"
        ).on("change", (change: any) => {
          // Skip Restore Engine Changes
          // Skip any with a : (umid, volatile, stream)
          if (
            change.doc._id.indexOf(":") == -1 &&
            (!change.doc.$activeledger ||
              (change.doc.$activeledger &&
                !change.doc.$activeledger.delete &&
                !change.doc.$activeledger.rewrite))
          ) {
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
        });
      });
    }
  );

  http.use(
    "/api/activity/subscribe",
    "POST",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

        // Listen for changes
        ActiveledgerDatasource.getChanges(
          (req.headers["Last-Event-ID"] as string) || "now"
        ).on("change", (change: any) => {
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
        });
      });
    }
  );

  // Events
  http.use(
    "/api/events/*/*",
    "GET",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

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
        });
      });
    }
  );

  http.use(
    "/api/events/*",
    "GET",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

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
        });
      });
    }
  );

  http.use(
    "/api/events",
    "GET",
    (
      incoming: IActiveHttpIncoming,
      req: IncomingMessage,
      res: ServerResponse
    ) => {
      return new Promise((resolve, reject) => {
        // Make sure we have an array
        res.statusCode = 200;

        // Set Header
        res.setHeader("Content-type", "text/event-stream");

        // Start Heartbeat
        const heartBeat = HeartBeat.Start(res);

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
        });
      });
    }
  );

  // Encryption
  http.use("/api/secured/decrypt", "POST", (incoming: IActiveHttpIncoming) => {
    return new Promise((resolve, reject) => {
      let secured = new ActiveCrypto.Secured(
        ActiveledgerDatasource.getDb(),
        ActiveledgerDatasource.getNeighbourhood(),
        {
          reference: ActiveNetwork.Home.reference,
          public: Buffer.from(ActiveNetwork.Home.publicPem, "base64").toString(
            "utf8"
          ),
          private: ActiveNetwork.Home.identity.pem
        }
      );
      secured
        .encrypt(incoming.body)
        .then(resolve)
        .catch(error => {
          resolve({
            statusCode: 500,
            message: error
          });
        });
    });
  });

  http.use("/api/secured/encrypt", "POST", (incoming: IActiveHttpIncoming) => {
    return new Promise((resolve, reject) => {
      let secured = new ActiveCrypto.Secured(
        ActiveledgerDatasource.getDb(),
        ActiveledgerDatasource.getNeighbourhood(),
        {
          reference: ActiveNetwork.Home.reference,
          public: Buffer.from(ActiveNetwork.Home.publicPem, "base64").toString(
            "utf8"
          ),
          private: ActiveNetwork.Home.identity.pem
        }
      );
      secured
        .decrypt(incoming.body)
        .then((result: any) => {
          resolve(result.data);
        })
        .catch(error => {
          resolve({
            statusCode: 500,
            message: error
          });
        });
    });
  });

  // Streams
  http.use(
    "/api/stream/changes",
    "GET",
    async (incoming: IActiveHttpIncoming) => {
      const changes = await ActiveledgerDatasource.getDb().changes({
        descending: true,
        include_docs: incoming.query.include_docs || false,
        limit: (incoming.query.limit || 10) * 3
      });
      if (changes) {
        // Filter in only the stream data documents
        let dataDocs = [];
        let i = changes.results.length;
        while (i--) {
          if (
            changes.results[i].id.indexOf(":") === -1 &&
            changes.results[i].id.indexOf("_design") === -1
          ) {
            dataDocs.push(changes.results[i]);
          }
        }
        return {
          changes: dataDocs
        };
      } else {
        return changes;
      }
    }
  );

  http.use(
    "/api/stream/search",
    "POST",
    async (incoming: IActiveHttpIncoming) => {
      let results;
      // Get Latest Version
      if (incoming.body.sql && incoming.body.sql.length > 15) {
        results = await ActiveledgerDatasource.getQuery().sql(
          incoming.body.sql
        );
      }

      if (incoming.body.mango && Object.keys(incoming.body.mango).length > 0) {
        results = await ActiveledgerDatasource.getQuery().mango(
          incoming.body.mango
        );
      }

      if (results) {
        let warning = ActiveledgerDatasource.getQuery().getLastWarning();
        if (warning) {
          return {
            streams: results,
            warning: warning
          };
        } else {
          return {
            streams: results
          };
        }
      } else {
        return {
          streams: [],
          warning: {
            query: "N/A",
            message: "No SQL or Mango query found"
          }
        };
      }
    }
  );

  http.use(
    "/api/stream/search",
    "GET",
    async (incoming: IActiveHttpIncoming) => {
      const results = await ActiveledgerDatasource.getQuery().sql(
        incoming.query.sql
      );
      if (results) {
        let warning = ActiveledgerDatasource.getQuery().getLastWarning();
        if (warning) {
          return {
            streams: results,
            warning: warning
          };
        } else {
          return {
            streams: results
          };
        }
      } else {
        return results;
      }
    }
  );

  http.use(
    "/api/stream/{id}/volatile",
    "GET",
    async (incoming: IActiveHttpIncoming) => {
      const results = await ActiveledgerDatasource.getDb().get(
        incoming.url[2] + ":volatile"
      );
      if (results) {
        return {
          stream: results
        };
      } else {
        return results;
      }
    }
  );
  http.use(
    "/api/stream/{id}/volatile",
    "POST",
    async (incoming: IActiveHttpIncoming) => {
      // Get Latest Version
      let results = await ActiveledgerDatasource.getDb().get(
        incoming.url[2] + ":volatile"
      );
      if (results) {
        // Update _id and _rev
        incoming.body._id = results._id;
        incoming.body._rev = results._rev;

        // Commit changes
        results = await ActiveledgerDatasource.getDb().put(incoming.body);
        return {
          success: results.ok
        };
      } else {
        return results;
      }
    }
  );

  http.use("/api/stream/*", "GET", async (incoming: IActiveHttpIncoming) => {
    const results = await ActiveledgerDatasource.getDb().get(incoming.url[2]);
    if (results) {
      return {
        stream: results
      };
    } else {
      return results;
    }
  });

  http.use("/api/stream", "POST", async (incoming: IActiveHttpIncoming) => {
    const results = await ActiveledgerDatasource.getDb().allDocs({
      include_docs: true,
      keys: incoming.body
    });
    if (results) {
      // Normalise the data from rows[].doc
      let i = results.rows.length;
      let streams = [];
      while (i--) {
        streams.push(results.rows[i].doc);
      }
      return {
        streams
      };
    } else {
      return results;
    }
  });

  // transaction
  http.use("/api/tx/*", "GET", async (incoming: IActiveHttpIncoming) => {
    const result = await ActiveledgerDatasource.getDb().get(
      incoming.url[2] + ":umid"
    );
    if (result) {
      return {
        umid: result.umid
      };
    } else {
      return result;
    }
  });

  // Misc
  http.use("/explorer", "GET", () => {
    // Redirect to Activeledger Swagger / Developer Portal Swagger
  });

  http.use("/openapi.json", "GET", () => {
    return readFileSync(__dirname + "/openapi.json");
  });

  // Listen!
  http.listen(8080, true);
} else {
  ActiveLogger.fatal("Configuration file incomplete");
  process.exit(0);
}
