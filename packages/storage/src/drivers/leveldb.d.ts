import { IStorageDriver } from "../driver";
import { LevelUpChain } from "levelup";
export declare const megabytes: (name: string, fallback: number) => number;
export declare const LEVELDB_DEFAULT_WRITE_BUFFER_MB = 64;
export declare const LEVELDB_DEFAULT_CACHE_MB = 256;
export declare const LEVELDB_LOG_CACHE_MB = 16;
export declare class LevelDBDriver implements IStorageDriver {
    private location;
    private logDatabase;
    private db;
    private opening;
    constructor(location: string, provider: string, logDatabase?: boolean);
    get(key: string): Promise<Buffer>;
    getOrUndefined(key: string): Promise<Buffer | undefined>;
    getMany(keys: string[]): Promise<Buffer[]>;
    put(key: string, value: any): Promise<void>;
    del(key: string): Promise<void>;
    batch(): Promise<LevelUpChain<any, any>>;
    createReadStream(options: any): any;
    createValueStream(): any;
    isOpen(): boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    compactRange(start: string, end: string): Promise<void>;
}
//# sourceMappingURL=leveldb.d.ts.map