// filterOldTxList on index.ts may be better to use this testing between the 2 will tell.

export class ActiveCache<T = any> {
  private data: Map<string, T>;
  private timers: Map<string, NodeJS.Timeout>;
  constructor(private ttl = 1200000) {
    this.data = new Map();
    this.timers = new Map();
  }

  public set(key: string, value: T, ttl?: number): void {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }
    this.timers.set(
      key,
      setTimeout(() => this.delete(key), ttl ?? this.ttl)
    );
    this.data.set(key, value);
  }

  public delete(key: string): void {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.data.delete(key);
  }

  public get(key: string, extend?: number): T | undefined {
    const value = this.data.get(key);
    if (value && extend) {
      // Refresh the TTL
      this.set(key, value, extend);
    }
    return value;
  }

  public has(key: string): boolean {
    return this.data.has(key);
  }

  public clear(): void {
    this.data.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  public size(): number {
    return this.data.size;
  }
}

export class ActiveCacheManager {
  private static caches: {
    [index: string]: ActiveCache;
  } = {};

  public static fetch<T = any>(name: string, ttl?: number): ActiveCache<T> {
    if (!this.caches[name]) {
      this.caches[name] = new ActiveCache(ttl);
    }
    return this.caches[name];
  }

  public static all(): ActiveCache<any>[] {
    return Object.values(this.caches);
  }
}
