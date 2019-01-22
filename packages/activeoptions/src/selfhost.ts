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
import * as path from "path";
import * as fs from "fs";
import { ActiveHttpd, IActiveHttpIncoming } from "./httpd";
import { ActiveLogger } from "@activeledger/activelogger";
import PouchDB from "./pouchdb";
import PouchDBFind from "./pouchdbfind";

(function() {
  // Add Find Plugin
  PouchDB.plugin(PouchDBFind);

  // Fauxton Path
  const FAUXTON_PATH = path.dirname(require.resolve("pouchdb-fauxton"));

  // Directory Prefix
  const DIR_PREFIX = "./" + process.argv[2] + "/";

  // PouchDB Connection Handler
  const PouchDb = PouchDB.defaults({ prefix: DIR_PREFIX });

  // PouchDB Connection Cache
  let pDBCache: any = {};

  /**
   * Manages Pouch Connections
   *
   * @param {string} name
   * @returns
   */
  let getPDB = (name: string) => {
    if (!pDBCache[name]) {
      pDBCache[name] = new PouchDb(name);
    }
    return pDBCache[name];
  };

  // Create Light Server
  let http = new ActiveHttpd();

  // Index
  http.use("/", "GET", () => {
    return {
      activeledger: "Welcome to Activeledger data!",
      adapters: ["leveldb"]
    };
  });

  // Standard Session
  http.use("_session", "ALL", () => {
    return { ok: true, userCtx: { name: null, roles: ["_admin"] } };
  });

  // List all databases
  http.use("_all_dbs", "ALL", async () => {
    // Check to see if it is a directory and not a special directory
    const isDirectory = (source: string) =>
      fs.lstatSync(DIR_PREFIX + source).isDirectory() &&
      source != process.argv[2] &&
      source != "pouch__all_dbs__" &&
      source != "_replicator" &&
      source.indexOf("-mrview-") === -1;

    // Return directories
    return fs.readdirSync(DIR_PREFIX).filter(isDirectory);
  });

  // Get Database Info
  http.use("*", "GET", async (incoming: IActiveHttpIncoming) => {
    // if (fs.existsSync(DIR_PREFIX + incoming.url[0])) {
    // Get Database
    let db = getPDB(incoming.url[0]);
    let info = await db.info();

    // Now add data_size
    info.data_size = 0;
    fs.readdirSync(DIR_PREFIX + incoming.url[0]).map((source: string) => {
      info.data_size += fs.statSync(
        DIR_PREFIX + incoming.url[0] + "/" + source
      ).size;
    });
    return info;
    // } else {
    //   return false;
    // }
  });

  // Create Database
  http.use("*", "PUT", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.body.name);

    // Create Database
    await db.info();

    return { ok: true };
  });

  // Delete Database Local Var
  let deleteDb = (dir: string) => {
    // Read all files and delete
    fs.readdirSync(dir).map((source: string) => {
      fs.unlinkSync(dir + "/" + source);
    });

    // Delete the folder
    fs.rmdirSync(dir);
  };

  // Delete Database
  http.use("*", "DELETE", async (incoming: IActiveHttpIncoming) => {
    // Can just delete the folder, It shouldn't have nested so can delete all the files first
    let dir = DIR_PREFIX + incoming.url[0];

    // Check Folder
    if (fs.existsSync(dir)) {
      // If we have this db open we need to close it
      if (pDBCache[incoming.url[0]]) {
        await pDBCache[incoming.url[0]].close();
        pDBCache[incoming.url[0]] = null;
      }

      // Delete Database
      deleteDb(dir);
    }
    return { ok: true };
  });

  // Get UUID
  http.use("_uuids", "GET", async (incoming: IActiveHttpIncoming) => {
    // Credit : https://gist.github.com/jed/982883
    let uuidGenV4 = (a?: any) =>
      a
        ? (a ^ ((Math.random() * 16) >> (a / 4))).toString(16)
        : (([1e7] as any) + -1e3 + -4e3 + -8e3 + -1e11).replace(
            /[018]/g,
            uuidGenV4
          );

    // uuid holder
    let uuids = [];

    // Loop for how many requested
    for (let i = 0; i < incoming.query.count; i++) {
      uuids.push(uuidGenV4());
    }
    return { uuids };
  });

  // Get Index
  http.use("/*/_index", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Db
    let db = getPDB(incoming.url[0]);
    return await db.getIndexes();
  });

  // Create Index
  http.use("/*/_index", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Db
    let db = getPDB(incoming.url[0]);
    return await db.createIndex(incoming.body);
  });

  // Delete Index
  http.use("/*/_index/*/*/*", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Db
    let db = getPDB(incoming.url[0]);
    return await db.deleteIndex({
      ddoc: incoming.url[2],
      type: incoming.url[3],
      name: incoming.url[4]
    });
  });

  // Replicator
  // May not need to replicate here, Service could be shut down
  // and processed directly on the files
  let replicator = async (incoming: IActiveHttpIncoming) => {
    if (incoming.body && incoming.body.source && incoming.body.target) {
      // Get names from URL
      let source = incoming.body.source.url.substr(
        incoming.body.source.url.lastIndexOf("/") + 1
      );

      let target = incoming.body.target.url.substr(
        incoming.body.target.url.lastIndexOf("/") + 1
      );

      // Replicate
      ActiveLogger.warn(`Replication : ${source} -> ${target}`);
      return await getPDB(source).replicate.to(getPDB(target));
    } else {
      return "";
    }
  };

  // Pouch URL
  http.use("/_replicate", "POST", async (incoming: IActiveHttpIncoming) => {
    return await replicator(incoming);
  });

  // Fauxton URL
  http.use("/_replicator", "POST", async (incoming: IActiveHttpIncoming) => {
    return await replicator(incoming);
  });

  // Restore (Activerestore selfhost, No need to do over http)
  http.use(
    "/smash",
    "GET",
    (incoming: IActiveHttpIncoming): Promise<unknown> => {
      return new Promise(async (resolve, reject) => {
        // Smashing
        ActiveLogger.warn(
          `Restoration : ${incoming.query.s} -> ${incoming.query.t}`
        );

        // Array of rewrite updates
        let bulkdocs: any = [];

        // Get Current & New
        let source = getPDB(incoming.query.s);
        let target = getPDB(incoming.query.t);

        // Make sure target exists
        await target.info();

        // Replicate source to target with filter
        source.replicate
          .to(target, {
            filter: (doc: any) => {
              if (
                doc.$activeledger &&
                doc.$activeledger.delete &&
                doc.$activeledger.rewrite
              ) {
                // Get Rewrite for later
                bulkdocs.push(doc.$activeledger.rewrite);
                return false;
              } else {
                return true;
              }
            }
          })
          .then(() => {
            // Any Bulk docs to update
            if (bulkdocs.length) {
              ActiveLogger.warn(
                `Restoration : ${bulkdocs.length} streams being corrected`
              );
              target.bulkDocs(bulkdocs, { new_edits: false }).then(async () => {
                // Now we need to delete the source, rename the target
                ActiveLogger.warn(`Restoration : Datastore stopping...`);

                // Close Source Databases
                await source.close();
                pDBCache[incoming.query.s] = null;

                // Close Target Databases
                await target.close();
                pDBCache[incoming.query.t] = null;

                // Delete Source Database
                deleteDb(DIR_PREFIX + incoming.query.s);

                // Rename Target to Source
                fs.renameSync(
                  DIR_PREFIX + incoming.query.t,
                  DIR_PREFIX + incoming.query.s
                );
                ActiveLogger.warn(`Restoration : Datastore starting...`);

                resolve({ ok: true });
              });
            } else {
              resolve({ ok: true });
            }
          })
          .catch((e: Error) => reject(e));
      });
    }
  );

  // Get all docs from a database
  http.use("*/_all_docs", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);

    // Convert Limit
    if (incoming.query.limit) {
      incoming.query.limit = parseInt(incoming.query.limit) || null;
    }

    // Convert startkey to remove "
    if (incoming.query.startkey) {
      incoming.query.startkey = incoming.query.startkey.replace(/"/g, "");
    }

    // Convert endkey to remove " and keep unicode search
    if (incoming.query.endkey) {
      incoming.query.endkey = incoming.query.endkey.replace(/"/g, "");
      incoming.query.endkey = incoming.query.endkey.slice(0, -1) + "\u9999";
    }

    return await db.allDocs(incoming.query);
  });

  // Get all docs filtered from a database
  http.use("*/_all_docs", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);

    // Convert Limit
    if (incoming.query.limit) {
      incoming.query.limit = parseInt(incoming.query.limit) || null;
    }

    return await db.allDocs(Object.assign(incoming.query, incoming.body));
  });

  // Get specific docs from a database
  http.use("*/*", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    try {
      return await db.get(decodeURIComponent(incoming.url[1]));
    } catch (e) {
      return e;
    }
  });

  // Specific lookup path for _local database docs
  http.use("*/_local/*", "GET", async (incoming: IActiveHttpIncoming) => {
    console.log("HELLO WORLD");
    console.log(decodeURIComponent(incoming.url[1] + "/" + incoming.url[2]));
    // Get Database
    let db = getPDB(incoming.url[0]);
    try {
      return await db.get(
        decodeURIComponent(incoming.url[1] + "/" + incoming.url[2])
      );
    } catch (e) {
      return e;
    }
  });

  // Add new / updated document to the database
  http.use("*/*", "PUT", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    try {
      return await db.put(incoming.body);
    } catch (e) {
      return "";
    }
  });

  // Listen for changes on the database
  http.use(
    "*/_changes",
    "GET",
    async (
      incoming: IActiveHttpIncoming,
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => {
      // Get Database
      let db = getPDB(incoming.url[0]);

      // Limit check
      if (incoming.query.limit < 1) {
        incoming.query.limit = 1;
      }

      // Convert since into number if not now
      if (incoming.query.since !== "now") {
        incoming.query.since = parseInt(incoming.query.since);
      }

      if (
        incoming.query.feed === "continuous" ||
        incoming.query.feed === "longpoll"
      ) {
        if (incoming.query.feed === "continuous") {
          // Currently we do not do continuous
        } else {
          //Long polling heartbeat
          let hBInterval = setInterval(() => {
            res.write("\n");
          }, incoming.query.heartbeat);

          // Clean up
          let cleanUp = () => {
            if (hBInterval) {
              clearInterval(hBInterval);
            }
          };

          // Set Header
          res.setHeader("Content-type", ActiveHttpd.mimeType[".json"]);

          // Read Type
          incoming.query.live = incoming.query.continuous = false;

          db.changes(incoming.query).then((complete: any) => {
            if (complete.results.length) {
              res.write(JSON.stringify(complete));
              res.end();
              cleanUp();
            } else {
              // do the longpolling
              // mimicking CouchDB, start sending the JSON immediately
              res.write('{"results":[\n');
              incoming.query.live = incoming.query.continuous = true;
              let changes = db
                .changes(incoming.query)
                .on("change", (change: any) => {
                  res.write(JSON.stringify(change));
                  res.write('],\n"last_seq":' + change.seq + "}\n");
                  changes.cancel();
                })
                .on("error", (e: any) => {
                  req.connection.removeListener("close", cancelChanges);
                  res.end();
                  cleanUp();
                })
                .on("complete", () => {
                  req.connection.removeListener("close", cancelChanges);
                  res.end();
                  cleanUp();
                });

              // Stop listening for changes
              let cancelChanges = () => {
                changes.cancel();
              };

              // Run on close connection
              req.connection.on("close", cancelChanges);
            }
          });
        }
        return "handled";
      } else {
        // Just get the latest
        return await db.changes(incoming.query);
      }
    }
  );

  // Add new / updated BULK document to the database
  http.use("*/_bulk_docs", "POST", async (incoming: IActiveHttpIncoming) => {
    // Can no longer be an array
    if (!Array.isArray(incoming.body)) {
      // Must have docs
      if (incoming.body.docs) {
        // Options for new_edits
        let opts = {
          new_edits: incoming.body.new_edits || false
        };

        // Get Database
        let db = getPDB(incoming.url[0]);

        // Bulk Insert
        return await db.bulkDocs(incoming.body.docs, opts);
      }
    }
  });

  // Find API
  http.use("*/_find", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    return await db.find(incoming.body);
  });

  // Explain
  http.use("*/_explain", "POST", async (incoming: IActiveHttpIncoming) => {
    let db = getPDB(incoming.url[0]);
    return await db.explain(incoming.body);
  });

  // Fauxton
  http.use(
    "_utils/**",
    "ALL",
    (
      incoming: IActiveHttpIncoming,
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => {
      // We want to force /_utils to /_utils/ as this is the CouchDB behavior
      if (req.url === "/_utils") {
        res.writeHead(301, {
          Location: "/_utils/"
        });
        return;
      }

      // File to send
      let file = FAUXTON_PATH + "/index.html";

      // If path is not default overwrite
      if (req.url !== "/_utils/") {
        file = FAUXTON_PATH + (req.url as string).replace("/_utils", "");
      }

      if (fs.existsSync(file)) {
        res.setHeader(
          "Content-type",
          ActiveHttpd.mimeType[path.parse(file).ext] || "text/plain"
        );
        // Convert To Stream
        return fs.readFileSync(file);
      }
    }
  );

  // Start Server
  http.listen(parseInt(process.argv[3]));
})();
