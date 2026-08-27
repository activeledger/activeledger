import { IStorageDriver } from "../driver";
import { LevelUpChain } from "levelup";
import { mkdirSync } from "fs";
import { ClassicLevel } from "classic-level";
import { Readable } from "stream";

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
        this.db = new ClassicLevel(this.location, { valueEncoding: 'binary' });
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
