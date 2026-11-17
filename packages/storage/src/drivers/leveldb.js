import { mkdirSync } from "fs";
import { ClassicLevel } from "classic-level";
import { Readable } from "stream";
const MB = 1024 * 1024;
export const megabytes = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_MB) * MB : fallback * MB;
};
const MAX_MB = 4096;
export const LEVELDB_DEFAULT_WRITE_BUFFER_MB = 64;
export const LEVELDB_DEFAULT_CACHE_MB = 256;
export const LEVELDB_LOG_CACHE_MB = 16;
export class LevelDBDriver {
    location;
    logDatabase;
    db = null;
    opening = false;
    constructor(location, provider, logDatabase = false) {
        this.location = location;
        this.logDatabase = logDatabase;
        mkdirSync(location, { recursive: true });
    }
    async get(key) {
        const val = await this.db.get(key);
        if (val === undefined) {
            const err = new Error(`Key not found in database [${key}]`);
            err.notFound = true;
            err.code = "LEVEL_NOT_FOUND";
            throw err;
        }
        return Buffer.isBuffer(val) ? val : Buffer.from(val);
    }
    async getOrUndefined(key) {
        const val = await this.db.get(key);
        if (val === undefined)
            return undefined;
        return Buffer.isBuffer(val) ? val : Buffer.from(val);
    }
    async getMany(keys) {
        const vals = await this.db.getMany(keys);
        return vals
            .filter((v) => v !== undefined)
            .map((v) => Buffer.isBuffer(v) ? v : Buffer.from(v));
    }
    async put(key, value) {
        await this.db.put(key, value);
    }
    async del(key) {
        await this.db.del(key);
    }
    async batch() {
        if (!this.db || this.db.status !== 'open') {
            await this.open();
        }
        return this.db.batch();
    }
    createReadStream(options) {
        const iterator = this.db.iterator(options);
        return new Readable({
            objectMode: true,
            async read() {
                try {
                    const entry = await iterator.next();
                    if (entry) {
                        const val = entry[1];
                        this.push({ key: entry[0], value: val === undefined ? undefined : Buffer.isBuffer(val) ? val : Buffer.from(val) });
                    }
                    else {
                        this.push(null);
                        await iterator.close();
                    }
                }
                catch (err) {
                    this.emit("error", err);
                    this.push(null);
                }
            },
            async destroy(err, callback) {
                await iterator.close();
                callback(err);
            }
        });
    }
    createValueStream() {
        const iterator = this.db.values();
        return new Readable({
            objectMode: true,
            async read() {
                try {
                    const val = await iterator.next();
                    if (val !== undefined) {
                        this.push(Buffer.isBuffer(val) ? val : Buffer.from(val));
                    }
                    else {
                        this.push(null);
                        await iterator.close();
                    }
                }
                catch (err) {
                    this.emit("error", err);
                    this.push(null);
                }
            },
            async destroy(err, callback) {
                await iterator.close();
                callback(err);
            }
        });
    }
    isOpen() {
        return this.db?.status === 'open';
    }
    async open() {
        if (this.db?.status !== 'open' && !this.opening) {
            this.opening = true;
            try {
                this.db = new ClassicLevel(this.location, {
                    valueEncoding: 'binary',
                    writeBufferSize: megabytes("ACTIVE_LEVEL_WRITE_BUFFER_MB", LEVELDB_DEFAULT_WRITE_BUFFER_MB),
                    cacheSize: megabytes("ACTIVE_LEVEL_CACHE_MB", this.logDatabase ? LEVELDB_LOG_CACHE_MB : LEVELDB_DEFAULT_CACHE_MB),
                });
                await this.db.open();
            }
            catch (e) {
                this.db = null;
                throw e;
            }
            finally {
                this.opening = false;
            }
        }
    }
    async close() {
        await this.db.close();
    }
    async compactRange(start, end) {
        if (typeof this.db.compactRange === 'function') {
            await this.db.compactRange(start, end);
        }
    }
}
//# sourceMappingURL=leveldb.js.map