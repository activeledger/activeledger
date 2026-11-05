import { IStorageDriver } from "../driver";
import { LevelUpChain } from "levelup";
import { mkdirSync } from "fs";
import { ClassicLevel } from "classic-level";
import { Readable } from "stream";

const MB = 1024 * 1024;

/**
 * A size in megabytes from the environment (set by the node from
 * db.selfhost.writeBufferMb / cacheMb when it starts the storage process),
 * or the default. Not a positive number means the default.
 */
const megabytes = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * MB : fallback * MB;
};

/**
 * LevelDB's own defaults (a 4 MB write buffer, an 8 MB block cache) suit a
 * small embedded store, not a ledger taking hundreds of writes a second: the
 * memtable fills and flushes over and over, compaction competes for the
 * threadpool, and the hot working set never fits the cache. One storage
 * process runs per node and nodes have the memory, so default to 64 MB of
 * write buffer and 256 MB of block cache per database. Durability is untouched
 * (writes are still not synced per batch; that has never changed).
 */
export const LEVELDB_DEFAULT_WRITE_BUFFER_MB = 64;
export const LEVELDB_DEFAULT_CACHE_MB = 256;

export class LevelDBDriver implements IStorageDriver {
  private db: any = null;
  private opening: boolean = false;

  constructor(private location: string, provider: string) {
    mkdirSync(location, { recursive: true });
  }

  public async get(key: string): Promise<Buffer> {
    const val = await this.db.get(key);
    if (val === undefined) {
      // classic-level resolves undefined for a missing key instead of
      // throwing (unlike the older levelup/leveldown API) - callers
      // (prepareForWrite() in particular) check error.notFound to detect
      // a new document, so restore that convention here.
      const err: any = new Error(`Key not found in database [${key}]`);
      err.notFound = true;
      err.code = "LEVEL_NOT_FOUND";
      throw err;
    }
    return Buffer.isBuffer(val) ? val : Buffer.from(val);
  }

  public async getOrUndefined(key: string): Promise<Buffer | undefined> {
    const val = await this.db.get(key);
    if (val === undefined) return undefined;
    return Buffer.isBuffer(val) ? val : Buffer.from(val);
  }

  public async getMany(keys: string[]): Promise<Buffer[]> {
    const vals = await this.db.getMany(keys);
    // classic-level resolves undefined per-key for anything missing from
    // the batch (matching get()'s single-key behaviour) rather than
    // throwing - callers (permissionsChecker's stream lookups in
    // particular) request keys that legitimately don't always exist
    // (e.g. an optional ":stream" companion document) and rely on
    // getMany() simply omitting those, not on positional correspondence
    // to the input keys, so filter rather than converting undefined and
    // crashing the whole batch.
    return vals
      .filter((v: any) => v !== undefined)
      .map((v: any) => Buffer.isBuffer(v) ? v : Buffer.from(v));
  }

  public async put(key: string, value: any): Promise<void> {
    await this.db.put(key, value);
  }

  public async del(key: string): Promise<void> {
    await this.db.del(key);
  }

  public async batch(): Promise<LevelUpChain<any, any>> {
    if (!this.db || this.db.status !== 'open') {
        await this.open();
    }
    return this.db.batch();
  }

  public createReadStream(options: any): any {
    const iterator = this.db.iterator(options);

    return new Readable({
      objectMode: true,
      async read() {
        try {
          const entry = await iterator.next();
          if (entry) {
            const val = entry[1];
            this.push({ key: entry[0], value: Buffer.isBuffer(val) ? val : Buffer.from(val) });
          } else {
            this.push(null);
            await iterator.close();
          }
        } catch (err) {
          this.emit("error", err);
          this.push(null);
        }
      },
      async destroy(err: Error | null, callback: (error: Error | null) => void) {
        await iterator.close();
        callback(err);
      }
    });
  }

  // classic-level's values()/keys() return a modern async-iterable, not a
  // classic Node Readable stream - levelme.ts's backup() needs .on("data"),
  // so wrap it the same way createReadStream() wraps the kv iterator.
  public createValueStream(): any {
    const iterator = this.db.values();

    return new Readable({
      objectMode: true,
      async read() {
        try {
          const val = await iterator.next();
          if (val !== undefined) {
            this.push(Buffer.isBuffer(val) ? val : Buffer.from(val));
          } else {
            this.push(null);
            await iterator.close();
          }
        } catch (err) {
          this.emit("error", err);
          this.push(null);
        }
      },
      async destroy(err: Error | null, callback: (error: Error | null) => void) {
        await iterator.close();
        callback(err);
      }
    });
  }

  public isOpen(): boolean {
    return this.db?.status === 'open';
  }

  public async open(): Promise<void> {
    if (this.db?.status !== 'open' && !this.opening) {
      this.opening = true;
      try {
        this.db = new ClassicLevel(this.location, {
          valueEncoding: 'binary',
          writeBufferSize: megabytes("ACTIVE_LEVEL_WRITE_BUFFER_MB", LEVELDB_DEFAULT_WRITE_BUFFER_MB),
          cacheSize: megabytes("ACTIVE_LEVEL_CACHE_MB", LEVELDB_DEFAULT_CACHE_MB),
        });
        await this.db.open();
      } catch (e) {
        // If opening fails, ensure the DB instance is cleared so it doesn't hold resources/locks
        this.db = null;
        throw e;
      } finally {
        this.opening = false;
      }
    }
  }

  public async close(): Promise<void> {
    await this.db.close();
  }

  public async compactRange(start: string, end: string): Promise<void> {
    if (typeof (this.db as any).compactRange === 'function') {
        await (this.db as any).compactRange(start, end);
    }
  }
}
