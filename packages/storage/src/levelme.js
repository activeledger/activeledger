import { createHash } from "crypto";
import * as fs from "fs";
import { createWriteStream, createReadStream, } from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";
import { newLineTransform } from "./newlinestream";
import { ActiveCacheManager } from "@activeledger/activeoptions";
import { ActiveClone } from "@activeledger/activeutilities";
import { LevelDBDriver } from "./drivers/leveldb";
import { DEFAULT_PAGE_LIMIT, PAGE_BUDGET_MS, idRange, idTime } from "./prune";
export class LevelMe {
    name;
    static COMPRESS_ABOVE = 16 * 1024;
    static META_PREFIX = "ÿmeta-storeÿ";
    static DOC_PREFIX = "ÿdocument-storeÿ";
    static SEQ_PREFIX = "ÿby-sequenceÿ";
    changeEmitter = new EventEmitter();
    driver;
    cache;
    openingPromise = null;
    constructor(location, name, provider, cache = false) {
        this.name = name;
        this.driver = new LevelDBDriver(location + name, provider, /(event|error)/i.test(name));
        if (cache) {
            this.cache = ActiveCacheManager.fetch(`streams:${this.name}`, 30000);
        }
    }
    findCachedBranchEnd(doc) {
        return doc.rev_map[doc.winningRev].toString().padStart(16, "0");
    }
    async seqDocFromRoot(doc) {
        if (doc.winningRev && doc.rev_map && doc.rev_tree && doc.seq) {
            const twig = this.findCachedBranchEnd(doc);
            try {
                await this.open();
                return (await ActiveClone.deserialize(await this.driver.get(LevelMe.SEQ_PREFIX + twig)));
            }
            catch {
                return {};
            }
        }
        else {
            return doc;
        }
    }
    async open() {
        if (this.openingPromise) {
            return this.openingPromise;
        }
        if (!this.driver.isOpen()) {
            this.openingPromise = (async () => {
                try {
                    await this.driver.open();
                }
                catch (e) {
                    throw e;
                }
                finally {
                    this.openingPromise = null;
                }
            })();
            return this.openingPromise;
        }
    }
    async info() {
        try {
            await this.open();
            return {
                doc_count: "----",
                update_seq: 0,
                db_name: this.name,
                data_size: 0,
            };
        }
        catch (e) {
            return {
                doc_count: "----",
                update_seq: 0,
                db_name: this.name,
                data_size: 0,
            };
        }
    }
    async close() {
        if (!this.driver.isOpen()) {
            return;
        }
        await this.driver.close();
    }
    async backup(filename) {
        if (!filename) {
            filename = `${Date.now()}.alb`;
        }
        await fs.promises.writeFile(`${filename}.status`, filename);
        const writer = createWriteStream(filename);
        return new Promise((resolve, reject) => {
            let queue = Promise.resolve();
            writer.on("error", reject);
            this.driver
                .createValueStream()
                .on("data", (data) => {
                queue = queue.then(async () => {
                    const doc = await ActiveClone.deserialize(data);
                    writer.write(JSON.stringify(doc) + "\n");
                });
                queue.catch(() => { });
            })
                .on("error", reject)
                .on("end", async () => {
                try {
                    await queue;
                    await new Promise((done, fail) => {
                        writer.on("error", fail);
                        writer.end(done);
                    });
                    await fs.promises.unlink(`${filename}.status`);
                    resolve(undefined);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async restore(filename) {
        await fs.promises.writeFile(`${filename}.status`, "running");
        return new Promise((resolve, reject) => {
            let queue = Promise.resolve();
            const reader = createReadStream(filename);
            reader.on("error", reject);
            reader
                .pipe(newLineTransform())
                .on("data", (data) => {
                queue = queue.then(async () => {
                    try {
                        const doc = JSON.parse(data.toString());
                        ActiveLogger.info(`Restoring ${doc._id}`);
                        if (!(await this.bulkDocs([doc], { new_edits: true }))) {
                            throw new Error("write failed");
                        }
                    }
                    catch {
                        ActiveLogger.warn(`Restoring FAILED`);
                    }
                });
            })
                .on("error", reject)
                .on("end", async () => {
                try {
                    await queue;
                    await fs.promises.unlink(`${filename}.status`);
                    resolve(undefined);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    allDocs(options) {
        return new Promise(async (resolve, reject) => {
            try {
                const offset = parseInt(options.skip?.toString() || "0");
                await this.open();
                let rows = [];
                if (options.keys) {
                    const docs = await this.getMany(options.keys);
                    rows = docs.map(doc => ({ doc }));
                    return resolve({
                        total_rows: docs.length,
                        offset,
                        rows,
                    });
                }
                else {
                    let limit = options.limit || -1;
                    if (options.skip && limit !== -1) {
                        options.skip = parseInt(options.skip);
                        limit += options.skip;
                    }
                    const stream = this.driver.createReadStream({
                        gte: LevelMe.DOC_PREFIX + (options.startkey || ""),
                        lt: options.endkey
                            ? LevelMe.DOC_PREFIX + options.endkey
                            : LevelMe.META_PREFIX,
                        limit,
                    });
                    const docPromises = [];
                    stream.on("data", (data) => {
                        if (options.skip) {
                            options.skip--;
                            return;
                        }
                        const pending = ActiveClone.deserialize(data.value).then((doc) => {
                            if (options.include_docs) {
                                return doc;
                            }
                            else {
                                return {
                                    _id: doc._id,
                                    id: doc._id,
                                    key: doc._id,
                                    value: { rev: doc._rev },
                                };
                            }
                        });
                        pending.catch(() => { });
                        docPromises.push(pending);
                    })
                        .on("error", (err) => {
                        stream.destroy();
                        reject(err);
                    })
                        .on("end", async () => {
                        try {
                            const rows = await Promise.all(docPromises);
                            resolve({
                                total_rows: rows.length,
                                offset,
                                rows,
                            });
                        }
                        catch (e) {
                            reject(e);
                        }
                    });
                }
            }
            catch (e) {
                reject(e);
            }
        });
    }
    async get(key, raw = false) {
        if (this.cache) {
            const cacheKey = raw ? `raw:${key}` : key;
            if (!this.cache.has(cacheKey)) {
                await this.open();
                const doc = await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key));
                if (raw) {
                    this.cache.set(cacheKey, doc);
                }
                else {
                    this.cache.set(cacheKey, await this.seqDocFromRoot(doc));
                }
            }
            return this.cache.get(cacheKey, 30000);
        }
        else {
            await this.open();
            const doc = await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key));
            if (raw) {
                return doc;
            }
            else {
                return await this.seqDocFromRoot(doc);
            }
        }
    }
    async getMany(keys) {
        const cache = this.cache;
        if (cache && keys.every((key) => cache.has(key))) {
            return keys.map((key) => cache.get(key, 30000));
        }
        const prefixed = keys.map((key) => LevelMe.DOC_PREFIX + key);
        const result = await this.driver.getMany(prefixed);
        const decoded = await Promise.all(result.map((raw) => raw === undefined || raw === null
            ? undefined
            : ActiveClone.deserialize(raw)));
        const docs = [];
        for (const data of decoded) {
            if (!data || !data._id) {
                continue;
            }
            if (this.cache) {
                this.cache.set(data._id, data);
            }
            docs.push(data);
        }
        return docs;
    }
    async getSeq(seq) {
        return this.driver.get(LevelMe.SEQ_PREFIX + seq);
    }
    compact() {
        return new Promise((resolve, reject) => {
            if (this.driver.compactRange) {
                this.driver.compactRange(`${LevelMe.SEQ_PREFIX}0000000000000000`, `${LevelMe.SEQ_PREFIX}9999999999999999`).then(resolve).catch(reject);
            }
            else {
                reject("Compact Range not found");
            }
        });
    }
    async post(doc) {
        const writer = await this.prepareForWrite(doc, await this.driver.batch());
        try {
            await writer.chain.write();
            if (this.cache) {
                this.cache.set(`raw:${writer.changes.id}`, writer.changes.doc);
                this.cache.delete(writer.changes.id);
            }
        }
        catch (e) {
            this.cache?.clear();
            throw e;
        }
        this.emitChange(writer.changes);
        return {
            ok: true,
            id: doc._id,
            rev: writer.rev,
        };
    }
    async writeRaw(key, value) {
        await this.open();
        const result = await this.driver.put(LevelMe.DOC_PREFIX + key, await ActiveClone.serialize(value, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
        if (this.cache) {
            this.cache.delete(key);
            this.cache.delete(`raw:${key}`);
        }
        return result;
    }
    async put(doc) {
        return await this.post(doc);
    }
    async del(key) {
        await this.open();
        const batch = await this.driver.batch();
        batch.del(LevelMe.DOC_PREFIX + key);
        if (this.cache) {
            if (this.cache.has(key)) {
                this.cache.delete(key);
            }
            const rawKey = `raw:${key}`;
            if (this.cache.has(rawKey)) {
                this.cache.delete(rawKey);
            }
        }
        await batch.write();
    }
    async prune(request) {
        await this.open();
        const { kind, before } = request;
        const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
        const dryRun = request.dryRun === true;
        const requireProcessed = request.requireProcessed !== false;
        const range = idRange(kind);
        const options = { lt: LevelMe.DOC_PREFIX + range.lt, values: kind === "error" };
        if (request.after !== undefined)
            options.gt = LevelMe.DOC_PREFIX + request.after;
        else
            options.gte = LevelMe.DOC_PREFIX + range.gte;
        const started = Date.now();
        const doomed = [];
        let scanned = 0;
        let kept = 0;
        let last;
        let done = true;
        const stream = this.driver.createReadStream(options);
        try {
            for await (const entry of stream) {
                const id = entry.key.toString().slice(LevelMe.DOC_PREFIX.length);
                scanned++;
                last = id;
                const time = idTime(kind, id);
                if (time === undefined) {
                    kept++;
                }
                else if (time >= before) {
                    kept++;
                    if (range.ordered)
                        break;
                }
                else if (kind === "error" && requireProcessed) {
                    const doc = await ActiveClone.deserialize(entry.value).catch(() => undefined);
                    if (doc && doc.processed === true)
                        doomed.push(id);
                    else
                        kept++;
                }
                else {
                    doomed.push(id);
                }
                if (doomed.length >= limit || Date.now() - started > PAGE_BUDGET_MS) {
                    done = false;
                    break;
                }
            }
        }
        finally {
            stream.destroy?.();
        }
        if (!dryRun && doomed.length) {
            const batch = await this.driver.batch();
            for (const id of doomed)
                batch.del(LevelMe.DOC_PREFIX + id);
            await batch.write();
            if (this.cache) {
                for (const id of doomed) {
                    this.cache.delete(id);
                    this.cache.delete(`raw:${id}`);
                }
            }
        }
        return { removed: doomed.length, scanned, kept, next: done ? undefined : last, done };
    }
    async delSeq(keys) {
        await this.open();
        const batch = await this.driver.batch();
        for (let i = keys.length; i--;) {
            batch.del(LevelMe.SEQ_PREFIX + keys[i]);
        }
        await batch.write();
    }
    changes() {
        return this.changeEmitter;
    }
    async bulkDocs(docs, options) {
        return (await this.bulkDocsRevs(docs, options)).ok;
    }
    async bulkDocsRevs(docs, options) {
        let batch = await this.driver.batch();
        const changes = [];
        const revs = {};
        const collect = (writer) => {
            revs[writer.changes.id] = writer.rev;
            if (!writer.unchanged) {
                changes.push(writer.changes);
            }
        };
        const distinct = new Set(docs.map((d) => d._id)).size === docs.length;
        if (distinct && docs.length > 1) {
            const settled = await Promise.allSettled(docs.map((doc) => this.prepareForWrite(doc, batch, options)));
            for (let i = settled.length; i--;) {
                const result = settled[i];
                if (result.status === "rejected") {
                    throw result.reason;
                }
                batch = result.value.chain;
                collect(result.value);
            }
        }
        else {
            for (let i = docs.length; i--;) {
                const writer = await this.prepareForWrite(docs[i], batch, options);
                batch = writer.chain;
                collect(writer);
            }
        }
        try {
            await batch.write();
            if (this.cache) {
                for (let i = changes.length; i--;) {
                    this.cache.set(`raw:${changes[i].id}`, changes[i].doc);
                    this.cache.delete(changes[i].id);
                }
            }
        }
        catch (e) {
            ActiveLogger.error({ error: e, ids: docs.map((doc) => doc._id) }, "Bulk write failed");
            return { ok: false, revs: {} };
        }
        for (let i = changes.length; i--;) {
            this.emitChange(changes[i]);
        }
        return { ok: true, revs };
    }
    emitChange(change) {
        for (const listener of this.changeEmitter.rawListeners("change")) {
            try {
                listener.call(this.changeEmitter, change);
            }
            catch (listenerError) {
                ActiveLogger.error(listenerError, "change listener threw");
            }
        }
    }
    async prepareForWrite(doc, chain, options = { new_edits: true }) {
        await this.open();
        const md5 = createHash("md5").update(JSON.stringify({ ...doc, _rev: null })).digest("hex");
        let newRev = "";
        let currentDocRoot;
        try {
            const key = LevelMe.DOC_PREFIX + doc._id;
            const raw = this.driver.getOrUndefined
                ? await this.driver.getOrUndefined(key)
                : await this.driver.get(key);
            if (raw !== undefined) {
                currentDocRoot = (await ActiveClone.deserialize(raw));
            }
        }
        catch (error) {
            if (!error.notFound) {
                throw error;
            }
        }
        if (currentDocRoot) {
            if (doc._rev !== currentDocRoot._rev && !options.new_edits) {
                const [storedPos, storedMd5] = currentDocRoot._rev.split("-");
                const fromPos = doc._rev ? parseInt(doc._rev.split("-")[0]) : 0;
                if (storedMd5 === md5 && parseInt(storedPos) === fromPos + 1) {
                    return {
                        chain,
                        rev: currentDocRoot._rev,
                        unchanged: true,
                        changes: {
                            id: doc._id,
                            changes: [{ rev: currentDocRoot._rev }],
                            doc: currentDocRoot,
                            seq: Date.now(),
                        },
                    };
                }
                throw new Error(`Revision Mismatch: ${doc._id} @ ${doc._rev} !== ${currentDocRoot._rev}`);
            }
            if (options.force_rev) {
                newRev = options.force_rev;
            }
            else {
                const [p1, curmd5] = currentDocRoot._rev.split("-");
                if (md5 !== curmd5) {
                    newRev = `${parseInt(p1) + 1}-${md5}`;
                }
            }
            if (newRev) {
                doc._rev = newRev;
                chain.put(LevelMe.DOC_PREFIX + doc._id, await ActiveClone.serialize(doc, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
            }
        }
        else {
            if (!options.new_edits && doc._rev) {
                newRev = doc._rev;
            }
            else {
                newRev = `1-${md5}`;
            }
            doc._rev = newRev;
            chain.put(LevelMe.DOC_PREFIX + doc._id, await ActiveClone.serialize(doc, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
        }
        newRev = newRev || currentDocRoot?._rev || "";
        return {
            chain,
            rev: newRev,
            changes: {
                id: doc._id,
                changes: [{ rev: newRev }],
                doc,
                seq: Date.now(),
            },
        };
    }
    async changesFromSeq(options) {
        if (options.since !== "now") {
            await this.open();
        }
        return new Promise((resolve, reject) => {
            if (options.since === "now") {
                resolve({ results: [], last_seq: 0 });
                return;
            }
            const rows = [];
            const promises = [];
            const filter = {
                gt: LevelMe.SEQ_PREFIX,
                lt: LevelMe.DOC_PREFIX,
                limit: parseInt((options.limit || 5).toString()),
                reverse: options.descending && options.descending.toString() === "true"
                    ? true
                    : false,
            };
            if (options.since) {
                filter.gt =
                    LevelMe.SEQ_PREFIX + options.since.toString().padStart(16, "0");
            }
            this.driver
                .createReadStream(filter)
                .on("data", (data) => {
                const index = promises.length;
                const pending = ActiveClone.deserialize(data.value).then((doc) => {
                    const seq = parseInt(data.key.toString().replace(LevelMe.SEQ_PREFIX, ""));
                    const row = {
                        id: doc._id,
                        seq,
                        changes: [
                            {
                                rev: doc._rev,
                            },
                        ],
                    };
                    if (options.include_docs &&
                        JSON.parse(options.include_docs.toString())) {
                        row.doc = doc;
                    }
                    rows[index] = row;
                    return doc;
                });
                pending.catch(() => { });
                promises.push(pending);
            })
                .on("error", (err) => {
                reject(err);
            })
                .on("close", () => { })
                .on("end", async () => {
                try {
                    await Promise.all(promises);
                    resolve({
                        results: rows,
                        last_seq: 0,
                    });
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
}
//# sourceMappingURL=levelme.js.map