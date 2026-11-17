import * as fs from "fs";
import * as path from "path";
import { ActiveCacheManager } from "@activeledger/activeoptions";
import { LevelMe } from "./levelme";
import { eventsSince } from "./events";
import { checkDoc, filterPrefix, isValidDbName, prepareAllDocs, } from "./selfhost-helpers";
const overTheWire = (value) => {
    if (!value) {
        return null;
    }
    try {
        if (typeof value === "object" && !Buffer.isBuffer(value)) {
            return JSON.parse(JSON.stringify(value));
        }
        return JSON.parse(value.toString());
    }
    catch {
        return null;
    }
};
const requestBody = (data) => JSON.parse(JSON.stringify(data));
export class EmbeddedDSConnect {
    name;
    level;
    dir;
    constructor(location, name, engine = "level", cache = false) {
        this.name = name;
        if (!isValidDbName(name)) {
            throw new Error(`invalid database - ${name}`);
        }
        if (cache) {
            ActiveCacheManager.fetch(`streams:${name}`).clear();
        }
        this.level = new LevelMe(location, name, engine, cache);
        this.dir = location + name;
    }
    info() {
        return this.answer(async () => {
            const info = await this.level.info();
            const files = await fs.promises.readdir(this.dir);
            const stats = await Promise.all(files.map((source) => fs.promises.stat(this.dir + "/" + source)));
            info.data_size = stats.reduce((total, stat) => total + stat.size, 0);
            return info;
        });
    }
    get(id, options = {}) {
        return this.answer(() => this.level.get(filterPrefix(id, this.name)));
    }
    async exists(id) {
        const data = await this.get(id);
        return data?._id ? true : false;
    }
    allDocs(options) {
        return this.answer(() => this.level.allDocs(prepareAllDocs(options ? Object.assign({}, requestBody(options)) : {})));
    }
    bulkDocs(docs, options = {}, timeout) {
        return this.answer(async () => {
            const body = requestBody({ docs, options });
            if (!Array.isArray(body) && body.docs) {
                const written = await this.level.bulkDocsRevs(body.docs, body.options);
                return written.ok ? { ok: true, revs: written.revs } : { ok: false };
            }
        });
    }
    post(doc) {
        return this.answer(async () => {
            try {
                return await this.level.post(checkDoc(requestBody(doc)));
            }
            catch (e) {
                e.reason = e.message;
                throw e;
            }
        });
    }
    put(doc) {
        return this.answer(async () => {
            try {
                return await this.level.put(requestBody(doc));
            }
            catch (e) {
                e.reason = e.message;
                throw e;
            }
        });
    }
    purge(doc) {
        return this.answer(async () => {
            await this.level.del(filterPrefix(decodeURIComponent(doc._id), this.name));
            return { success: "ok" };
        });
    }
    clearCache(key) { }
    eventsSince(lastEventId) {
        return eventsSince(this.level, lastEventId);
    }
    close() {
        return this.level.close();
    }
    async answer(work) {
        let result;
        try {
            result = await work();
        }
        catch (e) {
            result = e;
        }
        return overTheWire(result);
    }
}
export async function openEmbeddedStorage(dir, options = {}) {
    const location = path.resolve(dir) + path.sep;
    fs.mkdirSync(location, { recursive: true });
    const engine = options.engine || "level";
    const data = new EmbeddedDSConnect(location, options.database || "activeledger", engine, options.cache === true);
    const events = new EmbeddedDSConnect(location, options.event || "activeledgerevents", engine);
    const errors = new EmbeddedDSConnect(location, options.error || "activeledgererrors", engine);
    for (const db of [data, events, errors]) {
        await db.level["open"]();
    }
    return {
        data,
        events,
        errors,
        close: async () => {
            await Promise.all([data.close(), events.close(), errors.close()]);
        },
    };
}
//# sourceMappingURL=embedded.js.map