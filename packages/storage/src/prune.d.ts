export type PruneKind = "umid" | "fail" | "event" | "error";
export declare const PRUNE_KINDS: PruneKind[];
export interface PruneRequest {
    kind: PruneKind;
    before: number;
    after?: string;
    limit?: number;
    dryRun?: boolean;
    requireProcessed?: boolean;
}
export interface PrunePage {
    removed: number;
    scanned: number;
    kept: number;
    next?: string;
    done: boolean;
}
export declare const DEFAULT_PAGE_LIMIT = 5000;
export declare const MAX_PAGE_LIMIT = 20000;
export declare const PAGE_BUDGET_MS = 2000;
export declare const MIN_AGE_MS: number;
export declare function idTime(kind: PruneKind, id: string): number | undefined;
export declare function idRange(kind: PruneKind): {
    gte: string;
    lt: string;
    ordered: boolean;
};
export declare function checkPruneRequest(body: unknown, now?: number): {
    ok: true;
    request: PruneRequest;
} | {
    ok: false;
    error: string;
};
//# sourceMappingURL=prune.d.ts.map