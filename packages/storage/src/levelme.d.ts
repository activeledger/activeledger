import { EventEmitter } from "events";
import { PrunePage, PruneRequest } from "./prune";
interface document {
    _id: string;
    _rev?: string | null;
    [key: string]: any;
}
interface allDocOptions {
    startkey?: string;
    endkey?: string;
    limit?: number;
    skip?: number;
    keys?: string[];
    include_docs?: boolean;
}
interface changesOptions {
    since?: number | "now";
    live?: boolean;
    limit?: number;
    descending?: boolean;
    include_docs?: boolean;
}
export declare class LevelMe {
    private name;
    private static readonly COMPRESS_ABOVE;
    private static META_PREFIX;
    private static DOC_PREFIX;
    private static SEQ_PREFIX;
    private changeEmitter;
    private driver;
    private cache?;
    private openingPromise;
    constructor(location: string, name: string, provider: string, cache?: boolean);
    private findCachedBranchEnd;
    private seqDocFromRoot;
    private open;
    info(): Promise<{
        doc_count: string;
        update_seq: number;
        db_name: string;
        data_size: number;
    }>;
    close(): Promise<void>;
    backup(filename?: string): Promise<unknown>;
    restore(filename: string): Promise<unknown>;
    allDocs(options: allDocOptions): Promise<unknown>;
    get(key: string, raw?: boolean): Promise<any>;
    getMany(keys: string[]): Promise<any[]>;
    getSeq(seq: string): Promise<Buffer<ArrayBufferLike>>;
    compact(): Promise<unknown>;
    post(doc: document): Promise<{
        ok: boolean;
        id: string;
        rev: string;
    }>;
    writeRaw(key: string, value: unknown): Promise<void>;
    put(doc: document | unknown): Promise<{
        ok: boolean;
        id: string;
        rev: string;
    }>;
    del(key: string): Promise<void>;
    prune(request: PruneRequest): Promise<PrunePage>;
    delSeq(keys: string[]): Promise<void>;
    changes(): EventEmitter;
    bulkDocs(docs: document[], options: {
        new_edits: boolean;
        force_rev?: string;
    }): Promise<boolean>;
    bulkDocsRevs(docs: document[], options: {
        new_edits: boolean;
        force_rev?: string;
    }): Promise<{
        ok: boolean;
        revs: {
            [id: string]: string;
        };
    }>;
    private emitChange;
    private prepareForWrite;
    changesFromSeq(options: changesOptions): Promise<{
        results: {
            id: string;
            changes: {
                rev: string;
            }[];
            doc?: document;
            seq: number;
        }[];
        last_seq: number;
    }>;
}
export {};
//# sourceMappingURL=levelme.d.ts.map