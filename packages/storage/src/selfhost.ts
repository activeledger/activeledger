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
import { ActiveHttpd, IActiveHttpIncoming } from "@activeledger/httpd";
import { LevelMe } from "./levelme";

(function () {
  // Fauxton Path
  const FAUXTON_PATH = __dirname + "/fauxton/";

  // Directory Prefix
  const DIR_PREFIX = "./" + process.argv[2] + "/";

  // Listening Port
  const PORT = process.argv[3];

  // Data Storage Engine Provider, level provides backwards compatiblility
  const DS_PROVIDER = process.argv[4] || "level";

  // Database Connection Cache
  let dbCache: { [index: string]: LevelMe } = {};

  /**
   * Manages Pouch Connections
   *
   * @param {string} name
   * @returns
   */
  const getDB = (name: string): LevelMe => {
    // Filter out annoying name in a very forcefull way
    if (name === "favicon.ico") {
      throw new Error("invalid database");
    }
    if (!dbCache[name]) {
      dbCache[name] = new LevelMe(DIR_PREFIX, name, DS_PROVIDER);
    }
    return dbCache[name];
  };

  /**
   * Fast uuidV4 Generator
   * Credit : https://gist.github.com/jed/982883
   *
   * @param {number} [a]
   * @returns {number}
   */
  const uuidGenV4 = (a?: number): number =>
    a
      ? (a ^ ((Math.random() * 16) >> (a / 4))).toString(16)
      : (([1e7] as any) + -1e3 + -4e3 + -8e3 + -1e11).replace(
          /[018]/g,
          uuidGenV4
        );

  /**
   * Checks for the existant of _id if not ads it and returns
   *
   * @param {*} doc
   * @returns {*}
   */
  const checkDoc = (doc: any): any => {
    if (!doc._id) doc._id = uuidGenV4();
    return doc;
  };

  // Create Light Server
  let http = new ActiveHttpd();

  // Index
  http.use("/", "GET", () => {
    return {
      activeledger: "Welcome to Activeledger data!",
      adapters: ["levelme"],
      engine: DS_PROVIDER,
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
    // Get Database
    let db = getDB(incoming.url[0]);
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
    let db = getDB(incoming.body.name);

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
      if (dbCache[incoming.url[0]]) {
        await dbCache[incoming.url[0]].close();
        delete dbCache[incoming.url[0]];
      }

      // Delete Database
      deleteDb(dir);
    }
    return { ok: true };
  });

  // Get UUID
  http.use("_uuids", "GET", async (incoming: IActiveHttpIncoming) => {
    // uuid holder
    let uuids = [];

    // Loop for how many requested
    for (let i = 0; i < incoming.query.count; i++) {
      uuids.push(uuidGenV4());
    }
    return { uuids };
  });

  // Get all docs from a database
  http.use("*/_all_docs", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);
    return await db.allDocs(prepareAllDocs(incoming.query));
  });

  // Get all docs filtered from a database
  http.use("*/_all_docs", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);
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
  const prepareAllDocs = (options: any) => {
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

    // Filter prefixes
    // Leaving this in even though filtering in permissionsChecker as well
    if (options.keys) {
      options.keys = options.keys.map((id: string) => filterPrefix(id));
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
  const genericGet = (dbLoc: string, path: string): Promise<any> => {
    // Get Database
    return new Promise(async (resolve, reject) => {
      // Get Database
      const db = getDB(dbLoc);
      // Filter
      db.get(filterPrefix(decodeURIComponent(path)))
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
  const genericDelete = (dbLoc: string, docName: string): Promise<any> => {
    return new Promise(async (resolve, reject) => {
      // Get Database
      const db = getDB(dbLoc);
      try {
        await db.del(filterPrefix(docName));
        return resolve({ success: "ok" });
      } catch (e) {
        return reject(e);
      }
    });
  };

  // TODO : Verify request source
  http.use("*/*", "DELETE", async (incoming: IActiveHttpIncoming) => {
    return await genericDelete(
      incoming.url[0],
      decodeURIComponent(incoming.url[1])
    );
  });

  // Start compacting process
  http.use("*/_compact", "GET", async (incoming: IActiveHttpIncoming) => {
    const db = getDB(incoming.url[0]);
    return await db.compact();
  });

  // Direct sequence get
  http.use("*/_seq/*", "GET", async (incoming: IActiveHttpIncoming) => {
    const db = getDB(incoming.url[0]);
    return await db.getSeq(incoming.url[2]);
  });

  // Direct sequence delete
  http.use("*/_seq/*", "DELETE", async (incoming: IActiveHttpIncoming) => {
    const db = getDB(incoming.url[0]);
    try {
      await db.delSeq([incoming.url[2]]);
      return { success: "ok" };
    } catch {
      throw new Error("Seq Delete Failed");
    }
  });

  // Get specific docs from a database
  http.use("*/*", "GET", async (incoming: IActiveHttpIncoming) => {
    return await genericGet(incoming.url[0], incoming.url[1]);
  });

  // Gets raw unparsed document straight from leveldb
  // Document Store http://localhost:5259/activeledger/_raw/[document._id]
  // Sequence (data) http://localhost:5259/activeledger/_raw/[document._id]@[revision] (revision Example = 10-f0b21ef22ec86f7c6d71c250b4563bba)
  http.use("*/_raw/*", "GET", async (incoming: IActiveHttpIncoming) => {
    // Getting revision?
    const [root, revision] = incoming.url[2].split("@");

    // Get Database
    const db = getDB(incoming.url[0]);

    // Get Main Doc
    const rootDoc = await db.get(decodeURIComponent(root), true);

    // If getting revision we need sequence
    if (revision) {
      try {
        return await db.getSeq(rootDoc.rev_map[revision]);
      } catch (e) {
        throw new Error("Revision Fetch Failed");
      }
    }
    return rootDoc;
  });

  // Add new / updated document to the database
  http.use("*/**", "PUT", async (incoming: IActiveHttpIncoming) => {
    // Archive Document?
    await markAsArchived(incoming);
    return genericPut(incoming.url[0], incoming.body);
  });

  /**
   * Detects if root pouch document needs to be archived and archives
   *
   * @param {IActiveHttpIncoming} incoming
   * @returns {Promise<boolean>}
   */
  const markAsArchived = async (
    incoming: IActiveHttpIncoming
  ): Promise<boolean> => {
    const position = isArchivable(incoming.body._rev);
    if (position) {
      try {
        // Get Database
        const db = getDB(incoming.url[0]);

        // Raw meta doc
        const metaDoc = await db.get(decodeURIComponent(incoming.url[1]), true);

        // Make sure archive database exists
        const archDb = await getCreateArchiveDb(incoming.url[0]);

        // Time to modify!
        const newMetaDoc = prepareArchiveDoc(metaDoc, position);

        // Prevent clashes
        metaDoc._id += ":" + position;

        // We could add to existing but then we would archive the archive
        // Write document to archive
        await archDb.post(checkDoc(metaDoc));

        // Rewrite meta root document
        await db.writeRaw(newMetaDoc._id, JSON.stringify(newMetaDoc));
        return true;
      } catch (e) {
        // Any errors continue
        return false;
      }
    }
    return false;
  };

  /**
   * Pouchdb Metadoc rewrite (trimming)
   *
   * @param {*} metaDoc
   * @param {string} position
   * @returns
   */
  const prepareArchiveDoc = (metaDoc: any, position: number) => {
    // Time to modify!
    const newMetaDoc = {
      _id: metaDoc._id,
      rev_tree: [
        {
          // pos: metaDoc.rev_tree[0].pos,
          pos: position - 1, // Get parent starting pos
          ids: getLastInTree(metaDoc.rev_tree[0].ids),
        },
      ],
      rev_map: {
        [metaDoc.winningRev]: metaDoc.rev_map[metaDoc.winningRev],
      },
      winningRev: metaDoc.winningRev,
      deleted: metaDoc.deleted,
      seq: metaDoc.seq,
    };
    return newMetaDoc;
  };

  /**
   * Create Archive Database
   *
   * @param {string} name
   * @returns
   */
  const getCreateArchiveDb = async (name: string): Promise<LevelMe> => {
    const archDb = getDB(name + "_archive");
    await archDb.info();
    return archDb;
  };

  /**
   * Gets the last 2 leafs in the tree (parent, current)
   *
   * @param {any[]} tree
   * @param {any[]} [prevTree]
   * @returns {*}
   */
  const getLastInTree = (tree: any[], prevTree?: any[]): any => {
    if (tree[2].length) {
      return getLastInTree(tree[2][0], tree);
    }
    return prevTree ? prevTree : tree;
  };

  /**
   * Should we Archive the document
   *
   * @param {string} revString
   * @returns {number}
   */
  const isArchivable = (revString: string): number => {
    if (revString) {
      const position = parseInt(revString.split("-")[0]);

      // Set at 300 to have 3 attempts before default 1000 id failure error triggered above
      //return position % 300 === 0 ? position : 0;
      return position % 15 === 0 ? position : 0;
    }
    return 0;
  };

  /**
   * Reusable Get for mutliple paths
   *
   * @param {string} dbLoc
   * @param {string} path
   * @returns {Promise<any>}
   */
  const genericPut = async (dbLoc: string, body: string): Promise<any> => {
    // Get Database
    let db = getDB(dbLoc);
    try {
      return await db.put(body);
    } catch (e) {
      e.reason = e.message;
      throw e;
    }
  };

  // Filters any prefix (so they're virtual) (: reserved character) to real stream id
  const filterPrefix = (stream: string): string => {
    // Remove any suffix like :volatile :stream :umid
    let [streamId, suffix] = stream.split(":");

    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      streamId = streamId.slice(-64);
    }

    // If suffix add it back to return
    if (suffix) {
      return streamId + ":" + suffix;
    }

    // Return just the id
    return streamId;
  };

  // Add new / updated document to the database with auto id
  http.use("*", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);

    // Archive Document?
    await markAsArchived(incoming);

    try {
      return await db.post(checkDoc(incoming.body));
    } catch (e) {
      e.reason = e.message;
      throw e;
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
      let db = getDB(incoming.url[0]);

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

          db.changesFromSeq(incoming.query).then((complete: any) => {
            if (complete.results.length) {
              res.write(JSON.stringify(complete));
              res.end();
              cleanUp();
            } else {
              // do the longpolling
              // mimicking CouchDB, start sending the JSON immediately
              res.write('{"results":[\n');
              incoming.query.live = incoming.query.continuous = true;

              // Listener Process event (to turn off)
              const listener = (change: any) => {
                if (!req.connection.destroyed) {
                  res.write(JSON.stringify(change));
                  res.write('],\n"last_seq":' + change.seq + "}\n");
                }
                res.end();
                cleanUp();
              };

              // Stop listening for changes
              const cancelChanges = () => {
                changes.off("change", listener);
                req.connection.off("close", cancelChanges);
              };

              // Run on close connection
              req.connection.on("close", cancelChanges);

              // Listening for changes
              let changes = db.changes().on("change", listener);
            }
          });
        }
        return "handled";
      } else {
        // Just get the latest
        return await db.changesFromSeq(incoming.query);
      }
    }
  );

  // Add new / updated BULK document to the database
  http.use("*/_bulk_docs", "POST", async (incoming: IActiveHttpIncoming) => {
    // Can no longer be an array
    if (!Array.isArray(incoming.body)) {
      // Must have docs
      if (incoming.body.docs) {
        // Get Database
        let db = getDB(incoming.url[0]);

        // Prepare Archive database
        // Make sure archive database exists
        const archDb = await getCreateArchiveDb(incoming.url[0]);

        // We need to see if the docs need archiving
        for (let i = incoming.body.docs.length; i--; ) {
          const doc = incoming.body.docs[i];
          const position = isArchivable(doc._rev);
          if (position) {
            try {
              // Raw meta doc
              const metaDoc = await db.get(doc._id, true);

              // Time to modify!
              const newMetaDoc = prepareArchiveDoc(metaDoc, position);

              // Prevent clashes
              metaDoc._id += ":" + position;

              // We could add to existing but then we would archive the archive
              // Write document to archive
              await archDb.post(checkDoc(metaDoc));

              // Rewrite meta root document
              await db.writeRaw(newMetaDoc._id, JSON.stringify(newMetaDoc));
            } catch (e) {
              // Ignore errors and continue
            }
          }
        }

        // Bulk Insert
        if (await db.bulkDocs(incoming.body.docs, incoming.body.options)) {
          return {
            ok: true,
          };
        } else {
          return {
            ok: false,
          };
        }
      }
    }
  });

  // Find API
  http.use("*/_find", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);
    return await db.find(incoming.body);
  });

  // Explain
  http.use("*/_explain", "POST", async (incoming: IActiveHttpIncoming) => {
    let db = getDB(incoming.url[0]);
    return await db.explain(incoming.body);
  });

  // Fauxton
  const fauxton = (
    incoming: IActiveHttpIncoming,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    // We want to force /_utils to /_utils/ as this is the CouchDB behavior
    if (req.url === "/_utils") {
      res.writeHead(301, {
        Location: "/_utils/",
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
  };
  http.use("_utils", "GET", fauxton);
  http.use("_utils/**", "ALL", fauxton);

  // Start Server
  http.listen(parseInt(PORT));
})();
