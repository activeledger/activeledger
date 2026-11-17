import { mkdirSync } from "fs";
const { RocksLevel } = require("@nxtedition/rocksdb");
export class RocksDBDriver {
    location;
    db = null;
    opening = false;
    constructor(location, provider) {
        this.location = location;
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
        const { Readable } = require("stream");
        return new Readable({
            objectMode: true,
            async read() {
                try {
                    const entry = await iterator.next();
                    if (entry) {
                        const val = entry[1];
                        this.push({ key: entry[0], value: Buffer.isBuffer(val) ? val : Buffer.from(val) });
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
        return this.db.values();
    }
    isOpen() {
        return this.db?.status === 'open';
    }
    async open() {
        if (this.db?.status !== 'open' && !this.opening) {
            this.opening = true;
            try {
                this.db = new RocksLevel(this.location, { valueEncoding: 'binary' });
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
//# sourceMappingURL=rocksdb.js.map