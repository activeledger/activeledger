import { IStorageDriver } from "../driver";
import { LevelUpChain } from "levelup";
export declare class RocksDBDriver implements IStorageDriver {
    private location;
    private db;
    private opening;
    constructor(location: string, provider: string);
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
//# sourceMappingURL=rocksdb.d.ts.map