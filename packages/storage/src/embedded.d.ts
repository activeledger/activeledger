import { LevelMe } from "./levelme";
export interface IDSConnect {
    info(): Promise<any>;
    get(id: string, options?: any): Promise<any>;
    exists(id: string): Promise<Boolean>;
    allDocs(options?: any): Promise<any>;
    bulkDocs(docs: any[], options?: any, timeout?: number): Promise<any>;
    post(doc: {}): Promise<any>;
    put(doc: {
        _id: string;
        _rev?: string;
    }): Promise<any>;
    purge(doc: {
        _id: string;
        _rev?: string;
    }): Promise<any>;
    clearCache(key: string): void;
}
export declare class EmbeddedDSConnect implements IDSConnect {
    readonly name: string;
    readonly level: LevelMe;
    private readonly dir;
    constructor(location: string, name: string, engine?: string, cache?: boolean);
    info(): Promise<any>;
    get(id: string, options?: any): Promise<any>;
    exists(id: string): Promise<boolean>;
    allDocs(options?: any): Promise<any>;
    bulkDocs(docs: any[], options?: any, timeout?: number): Promise<any>;
    post(doc: {}): Promise<any>;
    put(doc: {
        _id: string;
        _rev?: string;
    }): Promise<any>;
    purge(doc: {
        _id: string;
        _rev?: string;
    }): Promise<any>;
    clearCache(key: string): void;
    eventsSince(lastEventId: string): Promise<Array<[string, Record<string, unknown>]>>;
    close(): Promise<void>;
    private answer;
}
export interface IEmbeddedStorageOptions {
    engine?: string;
    database?: string;
    cache?: boolean;
    event?: string;
    error?: string;
}
export interface IEmbeddedStorage {
    data: EmbeddedDSConnect;
    events: EmbeddedDSConnect;
    errors: EmbeddedDSConnect;
    close(): Promise<void>;
}
export declare function openEmbeddedStorage(dir: string, options?: IEmbeddedStorageOptions): Promise<IEmbeddedStorage>;
//# sourceMappingURL=embedded.d.ts.map