import * as path from "path";
import { promises as fsPromises } from "fs";
import { randomUUID } from "crypto";
import { ActiveHttpd } from "@activeledger/httpd";
import { LevelMe } from "./levelme";
import { SSE } from "./sse";
import { EVENT_PREFIX, eventsSince } from "./events";
import { checkPruneRequest } from "./prune";
import { checkDoc, filterPrefix, isValidDbName, prepareAllDocs, } from "./selfhost-helpers";
import { ActiveLogger } from "@activeledger/activelogger";
(function () {
    const fauxtonCache = {};
    const FAUXTON_PATH = __dirname + "/fauxton/";
    const DIR_PREFIX = "./" + process.argv[2] + "/";
    const PORT = process.argv[3];
    const DS_PROVIDER = process.argv[4] || "level";
    const BIND_HOST = process.argv[5] || "127.0.0.1";
    const CACHED_DB = process.argv[6] || "";
    let dbCache = {};
    let isShuttingDown = false;
    const terminate = async (host) => {
        if (!isShuttingDown) {
            isShuttingDown = true;
            host.shutdown();
            const dbNames = Object.keys(dbCache);
            for (const name of dbNames) {
                try {
                    await dbCache[name].close();
                    ActiveLogger.info(`Closed database: ${name}`);
                }
                catch (err) {
                    ActiveLogger.error(`Error closing database ${name}:`, err);
                }
            }
            process.exit(0);
        }
    };
    const getDB = (name) => {
        if (!isValidDbName(name)) {
            throw new Error(`invalid database - ${name}`);
        }
        if (!dbCache[name]) {
            try {
                dbCache[name] = new LevelMe(DIR_PREFIX, name, DS_PROVIDER, CACHED_DB !== "" && name === CACHED_DB);
            }
            catch (err) {
                throw err;
            }
        }
        else {
        }
        return dbCache[name];
    };
    const uuidGenV4 = () => randomUUID();
    let http = new ActiveHttpd();
    process.on("SIGINT", () => {
        terminate(http);
    });
    process.on("SIGTERM", () => {
        terminate(http);
    });
    process.on("SIGQUIT", () => {
        terminate(http);
    });
    http.use("/", "GET", () => {
        return {
            activeledger: "Welcome to Activeledger data!",
            adapters: ["levelme"],
            engine: DS_PROVIDER,
        };
    });
    http.use("_session", "GET", () => {
        return { ok: true, userCtx: { name: null, roles: ["_admin"] } };
    });
    http.use("_all_dbs", "GET", async () => {
        const files = await fsPromises.readdir(DIR_PREFIX);
        const stats = await Promise.all(files.map((file) => fsPromises.lstat(DIR_PREFIX + file)));
        const dbs = files.filter((file, i) => stats[i].isDirectory() &&
            file !== process.argv[2] &&
            file !== "pouch__all_dbs__" &&
            file !== "_replicator" &&
            !file.includes("-mrview-"));
        return dbs;
    });
    http.use("*", "GET", async (incoming) => {
        let db = getDB(incoming.url[0]);
        let info = await db.info();
        const files = await fsPromises.readdir(DIR_PREFIX + incoming.url[0]);
        const stats = await Promise.all(files.map((source) => fsPromises.stat(DIR_PREFIX + incoming.url[0] + "/" + source)));
        info.data_size = stats.reduce((total, stat) => total + stat.size, 0);
        return info;
    });
    http.use("*", "PUT", async (incoming) => {
        let db = getDB(incoming.body.name);
        await db.info();
        return { ok: true };
    });
    const deleteDb = async (dir) => {
        const files = await fsPromises.readdir(dir);
        await Promise.all(files.map(source => fsPromises.unlink(dir + "/" + source)));
        await fsPromises.rmdir(dir);
    };
    http.use("*", "DELETE", async (incoming) => {
        let dir = DIR_PREFIX + incoming.url[0];
        try {
            await fsPromises.access(dir);
        }
        catch {
            return { ok: true };
        }
        if (dbCache[incoming.url[0]]) {
            await dbCache[incoming.url[0]].close();
            delete dbCache[incoming.url[0]];
        }
        await deleteDb(dir);
        return { ok: true };
    });
    http.use("_uuids", "GET", async (incoming) => {
        let uuids = [];
        for (let i = 0; i < incoming.query.count; i++) {
            uuids.push(uuidGenV4());
        }
        return { uuids };
    });
    http.use("*/_all_docs", "GET", async (incoming) => {
        let db = getDB(incoming.url[0]);
        return await db.allDocs(prepareAllDocs(incoming.query));
    });
    http.use("*/_all_docs", "POST", async (incoming) => {
        let db = getDB(incoming.url[0]);
        return await db.allDocs(prepareAllDocs(Object.assign(incoming.query, incoming.body)));
    });
    http.use("*/umids", "GET", async (incoming) => {
        return getTransactionUmids(incoming);
    });
    http.use("*/transactions", "GET", async (incoming) => {
        return getTransactionUmids(incoming);
    });
    const getTransactionUmids = async (incoming) => {
        let db = getDB(incoming.url[0]);
        if (incoming.query["from"].startsWith("umid:")) {
            incoming.query["startkey"] = incoming.query["from"];
        }
        else {
            incoming.query["startkey"] = `umid:${incoming.query["from"]}`;
        }
        const options = prepareAllDocs(incoming.query);
        if (!options.endkey) {
            options.endkey = "umid;";
        }
        const txs = (await db.allDocs(options));
        for (let i = txs.rows.length; i--;) {
            const [timestamp, umid] = txs.rows[i]._id.split(",");
            txs.rows[i] = {
                umid,
                timestamp: timestamp.replace("umid:", ""),
            };
        }
        return txs;
    };
    const genericGet = (dbLoc, path) => {
        return new Promise(async (resolve, reject) => {
            const db = getDB(dbLoc);
            db.get(filterPrefix(decodeURIComponent(path), dbLoc))
                .then((doc) => resolve(doc))
                .catch((e) => {
                reject(e);
            });
        });
    };
    const genericDelete = (dbLoc, docName) => {
        return new Promise(async (resolve, reject) => {
            const db = getDB(dbLoc);
            try {
                await db.del(filterPrefix(docName, dbLoc));
                return resolve({ success: "ok" });
            }
            catch (e) {
                return reject(e);
            }
        });
    };
    http.use("*/*", "DELETE", async (incoming) => {
        return await genericDelete(incoming.url[0], decodeURIComponent(incoming.url[1]));
    });
    http.use("*/_compact", "GET", async (incoming) => {
        const db = getDB(incoming.url[0]);
        return await db.compact();
    });
    http.use("*/_prune", "POST", async (incoming) => {
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
        }
        catch {
            throw { status: 404, error: "No such database" };
        }
        return await getDB(name).prune(checked.request);
    });
    http.use("*/_seq/*", "GET", async (incoming) => {
        const db = getDB(incoming.url[0]);
        return await db.getSeq(incoming.url[2]);
    });
    http.use("*/_seq/*", "DELETE", async (incoming) => {
        const db = getDB(incoming.url[0]);
        try {
            await db.delSeq([incoming.url[2]]);
            return { success: "ok" };
        }
        catch {
            throw new Error("Seq Delete Failed");
        }
    });
    const isSafeFilename = (filename) => typeof filename === "string" &&
        filename.length > 0 &&
        path.basename(filename) === filename;
    const runFileJob = async (label, job) => {
        try {
            await job();
        }
        catch (e) {
            ActiveLogger.error(e, `${label} failed`);
            throw {
                status: e?.code === "ENOENT" ? 404 : 500,
                error: `${label} failed: ${e?.message ?? String(e)}`,
            };
        }
    };
    http.use("*/_backup", "POST", async (incoming) => {
        const filename = incoming.body?.filename;
        if (filename !== undefined && !isSafeFilename(filename)) {
            throw new Error("Invalid backup filename");
        }
        await runFileJob("Backup", () => getDB(incoming.url[0]).backup(filename));
        return { status: "started" };
    });
    http.use("*/_restore", "POST", async (incoming) => {
        const filename = incoming.body?.filename;
        if (!isSafeFilename(filename)) {
            throw new Error("Invalid restore filename");
        }
        await runFileJob("Restore", () => getDB(incoming.url[0]).restore(filename));
        return { status: "started" };
    });
    http.use("*/*", "GET", async (incoming) => {
        return await genericGet(incoming.url[0], incoming.url[1]);
    });
    http.use("*/_raw/*", "GET", async (incoming) => {
        const [root, revision] = incoming.url[2].split("@");
        const db = getDB(incoming.url[0]);
        const rootDoc = await db.get(decodeURIComponent(root), true);
        if (revision) {
            try {
                return await db.getSeq(String(rootDoc.rev_map[revision]).padStart(16, "0"));
            }
            catch (e) {
                throw new Error("Revision Fetch Failed");
            }
        }
        return rootDoc;
    });
    http.use("*/**", "PUT", async (incoming) => {
        return genericPut(incoming.url[0], incoming.body);
    });
    const genericPut = async (dbLoc, body) => {
        let db = getDB(dbLoc);
        try {
            return await db.put(body);
        }
        catch (e) {
            e.reason = e.message;
            throw e;
        }
    };
    http.use("*", "POST", async (incoming) => {
        let db = getDB(incoming.url[0]);
        try {
            return await db.post(checkDoc(incoming.body));
        }
        catch (e) {
            e.reason = e.message;
            throw e;
        }
    });
    http.use("*/events", "GET", async (incoming, req, res) => {
        let db = getDB(incoming.url[0]);
        const sse = new SSE(res);
        const lastEventId = req.headers["Last-Event-ID"];
        let replayed = null;
        const send = (id, event) => {
            if (replayed && replayed.has(id)) {
                return true;
            }
            return sse.write(id, event);
        };
        let pending = lastEventId ? [] : null;
        const listener = (change) => {
            if (change.id.startsWith(EVENT_PREFIX)) {
                const id = change.id.slice(EVENT_PREFIX.length);
                delete change.doc._id;
                delete change.doc._rev;
                if (pending) {
                    pending.push([id, change.doc]);
                }
                else if (!send(id, change.doc)) {
                    cancelChanges();
                }
            }
        };
        const cancelChanges = () => {
            changes.off("change", listener);
        };
        sse.onDisconnect(cancelChanges);
        let changes = db.changes().on("change", listener);
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
            replayed = null;
        }
        return "handled";
    });
    http.use("*/_changes", "GET", async (incoming, req, res) => {
        let db = getDB(incoming.url[0]);
        if (incoming.query.limit < 1) {
            incoming.query.limit = 1;
        }
        if (incoming.query.since !== "now") {
            incoming.query.since = parseInt(incoming.query.since);
        }
        if (incoming.query.feed === "continuous" ||
            incoming.query.feed === "longpoll") {
            if (incoming.query.feed === "continuous") {
            }
            else {
                let hBInterval = null;
                let cleanUp = () => {
                    if (hBInterval) {
                        clearInterval(hBInterval);
                        hBInterval = null;
                    }
                };
                let headSent = false;
                const writeHead = (status) => {
                    if (headSent)
                        return;
                    headSent = true;
                    if (status)
                        res.writeStatus(status);
                    res.writeHeader("Content-type", ActiveHttpd.mimeType[".json"]);
                };
                incoming.query.live = incoming.query.continuous = false;
                db.changesFromSeq(incoming.query).then((complete) => {
                    if (complete.results.length) {
                        if (res.writable) {
                            res.cork(() => {
                                writeHead();
                                res.write(JSON.stringify(complete));
                                res.end();
                            });
                        }
                        cleanUp();
                    }
                    else {
                        if (res.writable) {
                            res.cork(() => {
                                writeHead();
                                res.write('{"results":[\n');
                            });
                        }
                        incoming.query.live = incoming.query.continuous = true;
                        hBInterval = setInterval(() => {
                            if (!res.writable) {
                                cleanUp();
                                cancelChanges();
                                return;
                            }
                            res.cork(() => {
                                res.write("\n");
                            });
                        }, Number(incoming.query.heartbeat) || 30000);
                        let pending = [];
                        let flushScheduled = false;
                        const flush = () => {
                            try {
                                if (!res.writable || pending.length === 0)
                                    return;
                                const batch = pending;
                                pending = [];
                                const lastSeq = batch.reduce((max, c) => (Number(c.seq) > max ? Number(c.seq) : max), 0);
                                res.cork(() => {
                                    res.write(batch.map((c) => JSON.stringify(c)).join(",\n"));
                                    res.write('],\n"last_seq":' + lastSeq + "}\n");
                                    res.end();
                                });
                            }
                            finally {
                                cleanUp();
                                cancelChanges();
                            }
                        };
                        const listener = (change) => {
                            pending.push(change);
                            if (!flushScheduled) {
                                flushScheduled = true;
                                setImmediate(flush);
                            }
                        };
                        const cancelChanges = () => {
                            changes.off("change", listener);
                        };
                        let changes = db.changes().on("change", listener);
                    }
                }).catch((error) => {
                    if (res.writable) {
                        res.cork(() => {
                            writeHead("500");
                            res.write(JSON.stringify({ error: String(error) }));
                            res.end();
                        });
                    }
                    cleanUp();
                });
            }
            return "handled";
        }
        else {
            return await db.changesFromSeq(incoming.query);
        }
    });
    http.use("*/_bulk_docs", "POST", async (incoming) => {
        if (!Array.isArray(incoming.body)) {
            if (incoming.body.docs) {
                let db = getDB(incoming.url[0]);
                const written = await db.bulkDocsRevs(incoming.body.docs, incoming.body.options);
                if (written.ok) {
                    return {
                        ok: true,
                        revs: written.revs,
                    };
                }
                else {
                    return {
                        ok: false,
                    };
                }
            }
        }
    });
    http.use("*/_find", "POST", async (incoming) => {
        return { error: "find is deprecated" };
    });
    http.use("*/_explain", "POST", async (incoming) => {
        return { error: "explain is deprecated" };
    });
    const fauxton = async (incoming, req, res) => {
        if (req.url === "/_utils") {
            req.url = "/_utils/";
        }
        let file = FAUXTON_PATH + "/index.html";
        if (req.url !== "/_utils/") {
            const requested = path.resolve(FAUXTON_PATH, "." + decodeURIComponent(req.url.replace("/_utils", "")));
            if (!requested.startsWith(path.resolve(FAUXTON_PATH) + path.sep)) {
                return fauxtonCache[FAUXTON_PATH + "/index.html"] || null;
            }
            file = requested;
        }
        if (fauxtonCache[file]) {
            return fauxtonCache[file];
        }
        try {
            await fsPromises.access(file);
            const data = await fsPromises.readFile(file);
            const response = {
                mime: `${ActiveHttpd.mimeType[path.parse(file).ext] || "text/plain"}`,
                data: data,
            };
            fauxtonCache[file] = response;
            return response;
        }
        catch {
        }
    };
    http.use("_utils", "GET", fauxton);
    http.use("_utils/**", "GET", fauxton);
    http.listen(parseInt(PORT), false, BIND_HOST);
})();
//# sourceMappingURL=selfhost.js.map