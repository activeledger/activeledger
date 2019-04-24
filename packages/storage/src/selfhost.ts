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
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveHttpd, IActiveHttpIncoming } from "./httpd";
import { PouchDB, leveldown } from "./pouchdb";

(function() {
  // Fauxton Path
  const FAUXTON_PATH = __dirname + "/fauxton/";

  // Directory Prefix
  const DIR_PREFIX = "./" + process.argv[2] + "/";

  // PouchDB Connection Handler
  const PouchDb = PouchDB.defaults({ prefix: DIR_PREFIX });

  // How PouchDB wraps documents keys
  const PouchDBDocBuffer = Buffer.from("ÿdocument-storeÿ");

  // PouchDB Connection Cache
  let pDBCache: any = {};

  // Leveldown Cache
  let leveldownCache: any = {};

  /**
   * Custom leveldown for Pouch (allows acceess to leveldown)
   *
   * @param {string} name
   * @returns
   */
  let levelupdown = (name: string) => {
    if (!leveldownCache[name]) {
      leveldownCache[name] = leveldown(name);
    }
    return leveldownCache[name];
  };

  /**
   * Manages Pouch Connections
   *
   * @param {string} name
   * @returns
   */
  let getPDB = (name: string) => {
    if (!pDBCache[name]) {
      pDBCache[name] = new PouchDb(name, {
        db: levelupdown
      });
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

  // Delete Index (Fauxton Way)
  http.use(
    "/*/_index/_bulk_delete",
    "POST",
    async (incoming: IActiveHttpIncoming) => {
      // Get Db
      let db = getPDB(incoming.url[0]);

      // Get all Indexes
      const indexes: any[] = (await db.getIndexes()).indexes;

      // Loop all indexes Fauxton wants to delete
      incoming.body.docids.forEach(async (docId: string) => {
        // Do we have this as a design index
        let index = indexes.find(
          (index: any): boolean => {
            return index.ddoc == docId;
          }
        );

        // Did we find a match to delete?
        if (index) {
          // Deleta via index delete
          await db.deleteIndex({
            ddoc: index.ddoc,
            type: index.type,
            name: index.name
          });
        }
      });

      return { ok: true };
    }
  );
  
  // Get all docs from a database
  http.use("*/_all_docs", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    return await db.allDocs(prepareAllDocs(incoming.query));
  });

  // Get all docs filtered from a database
  http.use("*/_all_docs", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    return await db.allDocs(
      prepareAllDocs(Object.assign(incoming.query, incoming.body))
    );
  });

  /**
   * C/Pouch conversion utility tool for _all_docs
   *
   * @param {*} options
   * @returns
   */
  let prepareAllDocs = (options: any) => {
    // Convert Limit
    if (options.limit) {
      options.limit = parseInt(options.limit) || null;
    }

    // Convert startkey to remove "
    if (options.startkey) {
      options.startkey = options.startkey.replace(/"/g, "");
    }

    // Convert endkey to remove " and keep unicode search
    if (options.endkey) {
      options.endkey = options.endkey.replace(/"/g, "");
      options.endkey = options.endkey.slice(0, -1) + "\u9999";
    }

    return options;
  };

  /**
   * Reusable Get for mutliple paths
   *
   * @param {string} dbLoc
   * @param {string} path
   * @returns {Promise<any>}
   */
  let genericGet = (dbLoc: string, path: string): Promise<any> => {
    // Get Database
    return new Promise(async (resolve, reject) => {
      // Get Database
      let db = getPDB(dbLoc);
      db.get(decodeURIComponent(path))
        .then((doc: unknown) => resolve(doc))
        .catch((e: unknown) => {
          reject(e);
        });
    });
  };

  /**
   * Reusable delete (purge like) for mutliple paths
   * TODO: Allow recusive delete docName []
   *
   * @param {string} dbLoc
   * @param {string} path
   * @returns {Promise<any>}
   */
  let genericDelete = (dbLoc: string, docName: string): Promise<any> => {
    return new Promise(async (resolve, reject) => {
      // Let Pouch create the connection
      await getPDB(dbLoc).info();
      // Get Database as leveldown
      let db = levelupdown(DIR_PREFIX + dbLoc);

      // make sure the database was opened by pouch
      if (db.status === "open") {
        // Direct Delete
        db.del(
          Buffer.concat([PouchDBDocBuffer, Buffer.from(docName)]),
          (error: unknown) => {
            if (error) {
              return reject(error);
            }
            // Return Ok
            return resolve({ success: "ok" });
          }
        );
      } else {
        return reject("database not opened");
      }
    });
  };

  // TODO : Verify request source
  http.use("*/*", "DELETE", async (incoming: IActiveHttpIncoming) => {
    return await genericDelete(incoming.url[0], incoming.url[1]);
  });

  // Get specific docs from a database
  http.use("*/*", "GET", async (incoming: IActiveHttpIncoming) => {
    return await genericGet(incoming.url[0], incoming.url[1]);
  });

  // Specific lookup path for _design database docs
  http.use("*/_design/*", "GET", async (incoming: IActiveHttpIncoming) => {
    return await genericGet(incoming.url[0], `_design/${incoming.url[2]}`);
  });

  // Specific lookup path for _local database docs
  http.use("*/_local/*", "GET", async (incoming: IActiveHttpIncoming) => {
    return await genericGet(incoming.url[0], `_local/${incoming.url[2]}`);
  });

  // Add new / updated document to the database
  http.use("*/**", "PUT", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    try {
      return await db.put(incoming.body);
    } catch (e) {
      return "";
    }
  });

  // Add new / updated document to the database with auto id
  http.use("*", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getPDB(incoming.url[0]);
    try {
      return await db.post(incoming.body);
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
          }, incoming.query.heartbeat || 60000);

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
          new_edits:
            incoming.body.new_edits ||
            (incoming.body.options && incoming.body.options.new_edits)
        };

        // Protect from being empty or bad value
        if (
          typeof opts.new_edits === "undefined" ||
          typeof opts.new_edits !== "boolean"
        ) {
          opts.new_edits = true;
        }

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
