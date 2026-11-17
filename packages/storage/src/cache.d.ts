export declare class Cache<T = any> {
    private ttl;
    private data;
    private timers;
    constructor(ttl?: number);
    set(key: string, value: T, ttl?: number): void;
    delete(key: string): void;
    get(key: string, extend?: number): T | undefined;
    has(key: string): boolean;
    clear(): void;
    size(): number;
}
export declare class CacheManager {
    private static caches;
    static fetch<T = any>(name: string, ttl?: number): Cache<T>;
    static all(): Cache<any>[];
}
//# sourceMappingURL=cache.d.ts.map