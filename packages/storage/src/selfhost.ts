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
import { promises as fsPromises } from "fs";
import { ActiveHttpd, IActiveHttpIncoming } from "@activeledger/httpd";
import { serveStorageSocket } from "./storagesocket";
import { LevelMe } from "./levelme";
//import { Socket } from "net";
import { SSE } from "./sse";
import { EVENT_PREFIX, eventsSince } from "./events";
import { checkPruneRequest } from "./prune";
import {
  checkDoc,
  dataSize,
  filterPrefix,
  isValidDbName,
  prepareAllDocs,
} from "./selfhost-helpers";
import { ActiveLogger } from "@activeledger/activelogger";
import { IActiveHttpResponse } from "@activeledger/httpd/lib/httpd";

(function () {
  // The explorer page, read once
  const pageCache: { [key: string]: { mime: string; data: Buffer } } = {};
  const EXPLORER_PATH = __dirname + "/explorer";

  // Directory Prefix
  const DIR_PREFIX = "./" + process.argv[2] + "/";

  // Listening Port
  const PORT = process.argv[3];

  // Data Storage Engine Provider, level provides backwards compatiblility
  const DS_PROVIDER = process.argv[4] || "level";

  // Which interface to listen on. This store has no authentication of any
  // kind - _bulk_docs will set any document to any revision, DELETE removes
  // a stream or the whole database - so it should be reachable only by the
  // node that owns it unless someone has deliberately decided otherwise.
  //
  // Local by default. An SSH tunnel still works (it connects from on the
  // host), and so does a container sharing the node's network namespace,
  // which is how the gateways reach it. Set db.selfhost.host to widen it.
  const BIND_HOST = process.argv[5] || "127.0.0.1";

  // Name of the one database given a read cache, or empty for none. Set
  // from db.selfhost.cache and only ever the ledger database: the events
  // and errors databases are written and scanned, never read by key, so a
  // cache there is filled and expired for nothing.
  const CACHED_DB = process.argv[6] || "";

  // Database Connection Cache
  let dbCache: { [index: string]: LevelMe } = {};

  // Track if we are shutting down
  let isShuttingDown = false;

  /**
   * Graceful Shutdown
   *
   * @param {ActiveHttpd} httpd host
   */
  const terminate = async (host: ActiveHttpd) => {
    if (!isShuttingDown) {
      isShuttingDown = true;
      host.shutdown();
      
      // Close all databases
      const dbNames = Object.keys(dbCache);
      for (const name of dbNames) {
        try {
          await dbCache[name].close();
          ActiveLogger.info(`Closed database: ${name}`);
        } catch (err) {
          ActiveLogger.error(`Error closing database ${name}:`, err);
        }
      }
      process.exit(0);
    }
  }

  /**
   * Manages Pouch Connections
   *
   * @param {string} name
   * @returns
   */
  const getDB = (name: string): LevelMe => {
    // Must start with activeledger (will cause problem with config need to resolve).
    // And nothing but a plain name after it: every distinct name opens (and
    // creates) its own LevelDB directory, so an unchecked suffix let any
    // request create databases on disk without limit.
    if (!isValidDbName(name)) {
      throw new Error(`invalid database - ${name}`);
    }
    if (!dbCache[name]) {
      try {
        dbCache[name] = new LevelMe(
          DIR_PREFIX,
          name,
          DS_PROVIDER,
          CACHED_DB !== "" && name === CACHED_DB
        );
      } catch (err) {
        throw err;
      }
    } else {
    }
    return dbCache[name];
  };

  // Create Light Server
  let http = new ActiveHttpd();

  // Attempt better shutdown
  process.on("SIGINT", () => {
    terminate(http);
  });
  process.on("SIGTERM", () => {
    terminate(http);
  });
  process.on("SIGQUIT", () => {
    terminate(http);
  });


  // A hand-rolled PID-file "already running" check used to live here:
  // record our PID on start, and on the next start, if a previous PID file
  // exists and `process.kill(pid, 0)` finds *any* live process with that
  // PID, refuse to start. That's unreliable the moment PIDs get reused,
  // which happens on every container restart (each gets a fresh, small PID
  // namespace) and eventually on bare metal too - a stale recorded PID
  // just needs to coincide with some unrelated process for this to produce
  // a false "Instance already running" that no amount of restarting fixes,
  // since the file was also never cleaned up except on a graceful
  // SIGINT/SIGTERM/SIGQUIT (see terminate() above) - a SIGKILL or crash
  // left it behind for good. Reproduced live: two nodes' storage refused
  // to restart after being recreated mid-session, in full isolation, with
  // no other process touching the same data - deleting the stale PID file
  // was the only fix.
  //
  // Removed rather than patched to clean up more reliably: LevelDB (via
  // LevelMe below) already takes a real OS-level advisory lock on its own
  // LOCK file per database when opened, which the kernel releases
  // automatically no matter how the holding process dies - no cleanup
  // logic needed, and it actually enforces single-writer correctness
  // instead of approximating it by PID. This custom check was redundant
  // with that at best, actively wrong at worst.

  http.use("/", "GET", () => {
    return {
      activeledger: "Welcome to Activeledger data!",
      adapters: ["levelme"],
      engine: DS_PROVIDER,
    };
  });

  // List all databases
  http.use("_all_dbs", "GET", async () => {
    // Check to see if it is a directory and not a special directory
    const files = await fsPromises.readdir(DIR_PREFIX);
    // Same pattern deleteDb() below already uses - stat every entry
    // concurrently instead of one at a time.
    const stats = await Promise.all(
      files.map((file) => fsPromises.lstat(DIR_PREFIX + file))
    );
    const dbs = files.filter(
      (file, i) =>
        stats[i].isDirectory() &&
        file !== process.argv[2] &&
        file !== "pouch__all_dbs__" &&
        file !== "_replicator" &&
        !file.includes("-mrview-")
    );

    // Return directories
    return dbs;
  });

  // Get Database Info
  http.use("*", "GET", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);
    let info = await db.info();

    // Now add data_size: the bytes the data is kept in (see dataSize)
    info.data_size = await dataSize(DIR_PREFIX + incoming.url[0]);
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
  const deleteDb = async (dir: string) => {
    // Read all files and delete
    const files = await fsPromises.readdir(dir);
    await Promise.all(files.map(source => fsPromises.unlink(dir + "/" + source)));

    // Delete the folder
    await fsPromises.rmdir(dir);
  };

  // Delete Database
  http.use("*", "DELETE", async (incoming: IActiveHttpIncoming) => {
    // Can just delete the folder, It shouldn't have nested so can delete all the files first
    let dir = DIR_PREFIX + incoming.url[0];

    // Check Folder
    try {
      await fsPromises.access(dir);
    } catch {
      // Directory doesn't exist, so we're good.
      return { ok: true };
    }
    // If we have this db open we need to close it
    if (dbCache[incoming.url[0]]) {
      await dbCache[incoming.url[0]].close();
      delete dbCache[incoming.url[0]];
    }
    // Delete Database
    await deleteDb(dir);
    return { ok: true };
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

  // Bit of a proxy call to focus on umids
  http.use("*/umids", "GET", async (incoming: IActiveHttpIncoming) => {
    return getTransactionUmids(incoming);
  });

  // The same listing under its other name, for third party applications that
  // navigate transactions by time (see "new: Umid Events")
  http.use("*/transactions", "GET", async (incoming: IActiveHttpIncoming) => {
    return getTransactionUmids(incoming);
  });

  // Filters the call to  focus on umid transaction (assuming right database!)
  const getTransactionUmids = async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);
    // Lets make sure it starts with umid:
    if (incoming.query["from"].startsWith("umid:")) {
      incoming.query["startkey"] = incoming.query["from"];
    } else {
      incoming.query["startkey"] = `umid:${incoming.query["from"]}`;
    }
    const options = prepareAllDocs(incoming.query);
    // Stop at the first key past every "umid:" id (";" follows ":"), as the
    // events reader does, or documents sorting after the prefix come back as
    // garbage rows
    if (!options.endkey) {
      options.endkey = "umid;";
    }
    const txs = (await db.allDocs(options)) as any;
    for (let i = txs.rows.length; i--;) {
      const [timestamp, umid] = txs.rows[i]._id.split(",");
      txs.rows[i] = {
        umid,
        timestamp: timestamp.replace("umid:", ""),
      };
    }
    return txs;
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
      db.get(filterPrefix(decodeURIComponent(path), dbLoc))
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
        await db.del(filterPrefix(docName, dbLoc));
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

  // Remove rows older than a time from a node's own stores (the events
  // database, the errors database and its archive): one page, which the
  // `activeledger prune` command asks for until it is done. A page is bounded
  // so the request ends well inside the server's idle timeout. Like every
  // route here it is reachable from this host only. It never creates a
  // database, and a cutoff newer than an hour ago is refused.
  http.use("*/_prune", "POST", async (incoming: IActiveHttpIncoming) => {
    const name = incoming.url[0];
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) {
      throw { status: 400, error: "Invalid database name" };
    }
    const checked = checkPruneRequest(incoming.body);
    if (!checked.ok) {
      throw { status: 400, error: checked.error };
    }
    try {
      await fsPromises.access(DIR_PREFIX + name);
    } catch {
      throw { status: 404, error: "No such database" };
    }
    return await getDB(name).prune(checked.request);
  });

  // filename comes straight from the request body here - without this
  // check it's an arbitrary file write/read primitive (LevelMe.backup()/
  // restore() pass it directly to createWriteStream()/createReadStream()
  // with no validation of their own, since they're also called from the
  // CLI's --backup/--restore flags where an operator-chosen path outside
  // the current directory is legitimate - the restriction belongs here,
  // at the boundary where the value is actually untrusted remote input,
  // not inside LevelMe itself). Restricting to a bare filename (no path
  // separators, no ".." components) blocks traversal and absolute paths
  // while still allowing any normal filename.
  const isSafeFilename = (filename: unknown): filename is string =>
    typeof filename === "string" &&
    filename.length > 0 &&
    path.basename(filename) === filename;

  // Runs a backup/restore and turns a failure into an HTTP error answer. It
  // used to be fired without await or catch, so a missing restore file was an
  // unhandled rejection that killed the whole storage process. A missing file
  // is the caller's mistake (404); anything else is a server-side failure (500).
  const runFileJob = async (label: string, job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (e: any) {
      ActiveLogger.error(e, `${label} failed`);
      throw {
        status: e?.code === "ENOENT" ? 404 : 500,
        error: `${label} failed: ${e?.message ?? String(e)}`,
      };
    }
  };

  http.use("*/_backup", "POST", async (incoming: IActiveHttpIncoming) => {
    const filename = incoming.body?.filename;
    if (filename !== undefined && !isSafeFilename(filename)) {
      throw new Error("Invalid backup filename");
    }
    await runFileJob("Backup", () => getDB(incoming.url[0]).backup(filename));
    return { status: "started" };
  });

  http.use("*/_restore", "POST", async (incoming: IActiveHttpIncoming) => {
    const filename = incoming.body?.filename;
    if (!isSafeFilename(filename)) {
      throw new Error("Invalid restore filename");
    }
    await runFileJob("Restore", () => getDB(incoming.url[0]).restore(filename));
    return { status: "started" };
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
        return await db.getSeq(
          // Sequence keys are 16 digit padded; rev_map holds the plain number
          String(rootDoc.rev_map[revision]).padStart(16, "0")
        );
      } catch (e) {
        throw new Error("Revision Fetch Failed");
      }
    }
    return rootDoc;
  });

  // Add new / updated document to the database
  http.use("*/**", "PUT", async (incoming: IActiveHttpIncoming) => {
    // Archive Document?
    //await markAsArchived(incoming);
    return genericPut(incoming.url[0], incoming.body);
  });

  /**
   * Detects if root pouch document needs to be archived and archives
   *
   * @param {IActiveHttpIncoming} incoming
   * @returns {Promise<boolean>}
   */
  // const markAsArchived = async (
  //   incoming: IActiveHttpIncoming
  // ): Promise<boolean> => {
  //   // No more btree archives, return false for now
  //   return false;

  //   const position = isArchivable(incoming.body._rev);
  //   if (position) {
  //     try {
  //       // Get Database
  //       const db = getDB(incoming.url[0]);

  //       // Raw meta doc
  //       const metaDoc = await db.get(decodeURIComponent(incoming.url[1]), true);

  //       // Make sure archive database exists
  //       const archDb = await getCreateArchiveDb(incoming.url[0]);

  //       // Time to modify!
  //       const newMetaDoc = prepareArchiveDoc(metaDoc, position);

  //       // Prevent clashes
  //       metaDoc._id += ":" + position;

  //       // We could add to existing but then we would archive the archive
  //       // Write document to archive
  //       await archDb.post(checkDoc(metaDoc));

  //       // Rewrite meta root document
  //       await db.writeRaw(newMetaDoc._id, JSON.stringify(newMetaDoc));
  //       return true;
  //     } catch (e) {
  //       // Any errors continue
  //       return false;
  //     }
  //   }
  //   return false;
  // };

  /**
   * Create Archive Database
   *
   * @param {string} name
   * @returns
   */
  // const getCreateArchiveDb = async (name: string): Promise<LevelMe> => {
  //   const archDb = getDB(name + "_archive");
  //   await archDb.info();
  //   return archDb;
  // };

  /**
   * Gets the last 2 leafs in the tree (parent, current)
   *
   * @param {any[]} tree
   * @param {any[]} [prevTree]
   * @returns {*}
   */
  // const getLastInTree = (tree: any[], prevTree?: any[]): any => {
  //   if (tree[2].length) {
  //     return getLastInTree(tree[2][0], tree);
  //   }
  //   return prevTree ? prevTree : tree;
  // };

  /**
   * Should we Archive the document
   *
   * @param {string} revString
   * @returns {number}
   */
  // const isArchivable = (revString: string): number => {
  //   if (revString) {
  //     const position = parseInt(revString.split("-")[0]);

  //     // Set at 300 to have 3 attempts before default 1000 id failure error triggered above
  //     //return position % 300 === 0 ? position : 0;
  //     return position % 15 === 0 ? position : 0;
  //   }
  //   return 0;
  // };

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

  // Add new / updated document to the database with auto id
  http.use("*", "POST", async (incoming: IActiveHttpIncoming) => {
    // Get Database
    let db = getDB(incoming.url[0]);

    // Archive Document?
    //await markAsArchived(incoming);

    try {
      return await db.post(checkDoc(incoming.body));
    } catch (e) {
      e.reason = e.message;
      throw e;
    }
  });

  http.use(
    "*/events",
    "GET",
    async (
      incoming: IActiveHttpIncoming,
      req: http.IncomingMessage,
      res: IActiveHttpResponse
    ) => {
      // Get Database
      let db = getDB(incoming.url[0]);

      const sse = new SSE(res);

      // ?also=umid,fail asks for those rows as well as the events, live only
      // (ids that are not event ids cannot be resumed, so Last-Event-ID is
      // ignored). Only these prefixes can be asked for; without it the stream
      // is the events alone, as it always was.
      const also = new Set(
        String(incoming.query?.["also"] ?? "")
          .split(",")
          .filter((kind) => ["umid", "fail", "resent"].includes(kind))
      );
      const lastEventId = also.size
        ? undefined
        : (req.headers["Last-Event-ID"] as string | undefined);

      // Ids the replay sent, so a live event that raced it is not sent twice.
      // Matched exactly: event ids do not sort by time as strings (the
      // counter is not zero-padded), so "anything before the last one sent"
      // would drop real events.
      let replayed: Set<string> | null = null;

      const send = (id: string, event: unknown): boolean => {
        if (replayed && replayed.has(id)) {
          return true;
        }
        return sse.write(id, event);
      };

      // Live events that arrive while a replay is still being read. Held
      // back and sent after it, in order, so the client never sees an event
      // before the ones it missed.
      let pending: Array<[string, unknown]> | null = lastEventId ? [] : null;

      // Listener Process event (to turn off)
      const listener = (change: any) => {
        if (also.size && also.has(String(change.id).split(":")[0])) {
          // Sent with its whole id and _id, so the reader can tell what it is
          const doc = { ...change.doc };
          delete doc._rev;
          if (!send(change.id, doc)) {
            cancelChanges();
          }
        } else if (change.id.startsWith(EVENT_PREFIX)) {
          const id = change.id.slice(EVENT_PREFIX.length);
          delete change.doc._id;
          delete change.doc._rev;
          if (pending) {
            pending.push([id, change.doc]);
          } else if (!send(id, change.doc)) {
            cancelChanges();
          }
        }
      };

      // Stop listening for changes
      const cancelChanges = () => {
        changes.off("change", listener);
      };

      // Run on disconnect immediately, rather than only being discovered
      // reactively the next time a change event fires and listener() sees
      // sse.write() return false - on a quiet database that could be a long
      // time (or never) after the client actually disconnects.
      sse.onDisconnect(cancelChanges);

      // Listening for changes. Attached BEFORE the replay is read: attached
      // after, an event committed during the read was in neither.
      let changes = db.changes().on("change", listener);

      // Resuming: send everything after the client's last event, then
      // whatever arrived meanwhile.
      if (lastEventId) {
        const missed = await eventsSince(db, lastEventId);
        for (const [id, event] of missed) {
          sse.write(id, event);
        }
        replayed = new Set(missed.map(([id]) => id));
        const held = pending || [];
        pending = null;
        for (const [id, event] of held) {
          if (!send(id, event)) {
            cancelChanges();
            break;
          }
        }
        // Only a live event that raced the replay can be a duplicate.
        replayed = null;
      }

      return "handled";
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
        //const archDb = await getCreateArchiveDb(incoming.url[0]);

        // We need to see if the docs need archiving
        // for (let i = incoming.body.docs.length; i--; ) {
        //   const doc = incoming.body.docs[i];
        //   const position = isArchivable(doc._rev);
        //   if (position) {
        //     try {
        //       // Raw meta doc
        //       const metaDoc = await db.get(doc._id, true);

        //       // Time to modify!
        //       const newMetaDoc = prepareArchiveDoc(metaDoc, position);

        //       // Prevent clashes
        //       metaDoc._id += ":" + position;

        //       // We could add to existing but then we would archive the archive
        //       // Write document to archive
        //       await archDb.post(checkDoc(metaDoc));

        //       // Rewrite meta root document
        //       await db.writeRaw(newMetaDoc._id, JSON.stringify(newMetaDoc));
        //     } catch (e) {
        //       // Ignore errors and continue
        //     }
        //   }
        // }

        // Bulk Insert
        let written: { ok: boolean; revs: { [id: string]: string } };
        try {
          written = await db.bulkDocsRevs(
            incoming.body.docs,
            incoming.body.options
          );
        } catch (e: any) {
          // An exception inside the store (a revision that no longer matches, say) used to reach the caller as {},
          // which says nothing, and was not logged here either. The writer reads it as a failed save either way;
          // now it, and this node's log, say why.
          const why = e && e.message ? e.message : String(e);
          ActiveLogger.error(`Bulk write failed: ${why}`);
          // Still a 500 (it is a fault), with the reason in the body
          throw { status: 500, ok: false, error: why };
        }
        if (written.ok) {
          // The revisions the store assigned, so the caller need not read
          // them back
          return {
            ok: true,
            revs: written.revs,
          };
        } else {
          return {
            ok: false,
          };
        }
      }
    }
  });

  // The page that used to be served here was the CouchDB admin UI, which this
  // store never was. Anything still pointing at /_utils goes to the explorer.
  const toExplorer = async (_incoming: IActiveHttpIncoming, _req: unknown, res: any) => {
    res.cork(() => {
      res.writeStatus("302 Found");
      res.writeHeader("Location", "/_explorer");
      res.end();
      res.writable = false;
    });
    return "handled";
  };
  http.use("_utils", "GET", toExplorer);
  http.use("_utils/**", "GET", toExplorer);

  // Explorer: one static page that reads this server's own API. Nothing is
  // resolved from the request path, so there is no file lookup to escape
  // from; every path under /_explorer answers with the same page.
  const explorer = async () => {
    const file = EXPLORER_PATH + "/index.html";
    if (pageCache[file]) return pageCache[file];
    try {
      const response = {
        mime: ActiveHttpd.mimeType[".html"] || "text/html",
        data: (await fsPromises.readFile(file)) as Buffer,
      };
      pageCache[file] = response;
      return response;
    } catch {
      // Not found, will result in a 404 from httpd
    }
  };
  http.use("_explorer", "GET", explorer);
  http.use("_explorer/**", "GET", explorer);

  // Start Server
  http.listen(parseInt(PORT), false, BIND_HOST);

  // Local socket for this node's own processes (db.selfhost.socket). The same
  // routes, without HTTP. The path comes from the node that launched us.
  if (process.env.ACTIVE_STORAGE_SOCKET) {
    serveStorageSocket(http, process.env.ACTIVE_STORAGE_SOCKET);
  }
})();
