import { IStorageDriver } from "../driver";
import { LevelUpChain } from "levelup";
import { mkdirSync } from "fs";
const { RocksLevel } = require("@nxtedition/rocksdb");

export class RocksDBDriver implements IStorageDriver {
  private db: any = null;
  private opening: boolean = false;

  constructor(private location: string, provider: string) {
    mkdirSync(location, { recursive: true });
  }

  public async get(key: string): Promise<Buffer> {
    const val = await this.db.get(key);
    if (val === undefined) {
      // abstract-level-based drivers resolve undefined for a missing key
      // instead of throwing (unlike the older levelup/leveldown API) -
      // callers (prepareForWrite() in particular) check error.notFound to
      // detect a new document, so restore that convention here.
      const err: any = new Error(`Key not found in database [${key}]`);
      err.notFound = true;
      err.code = "LEVEL_NOT_FOUND";
      throw err;
    }
    return Buffer.isBuffer(val) ? val : Buffer.from(val);
  }

  public async getMany(keys: string[]): Promise<Buffer[]> {
    const vals = await this.db.getMany(keys);
    return vals.map((v: any) => Buffer.isBuffer(v) ? v : Buffer.from(v));
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
    const { Readable } = require("stream");

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

  public createValueStream(): any {
    return this.db.values();
  }

  public isOpen(): boolean {
    return this.db?.status === 'open';
  }

  public async open(): Promise<void> {
    if (this.db?.status !== 'open' && !this.opening) {
      this.opening = true;
      try {
        this.db = new RocksLevel(this.location, { valueEncoding: 'binary' });
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
    // RocksLevel now handles compaction internally or via properties; 
    // for this driver we keep the API consistent.
    if (typeof (this.db as any).compactRange === 'function') {
        await (this.db as any).compactRange(start, end);
    }
  }
}
