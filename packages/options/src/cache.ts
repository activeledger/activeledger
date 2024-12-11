// filterOldTxList on index.ts may be better to use this testing between the 2 will tell.

export class ActiveCache {
  private data: Map<string, any>;
  private timers: Map<string, NodeJS.Timeout>;
  constructor(private ttl = 1200000) {
    this.data = new Map();
    this.timers = new Map();
  }

  public set(key: string, value: any, ttl?: number): void {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }
    this.timers.set(
      key,
      setTimeout(() => this.delete(key), ttl ? ttl : this.ttl)
    );
    this.data.set(key, value);
  }

  public delete(key: string) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }
    this.data.delete(key);
  }

  public get(key: string, extend?: number) {
    if (extend && this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => this.delete(key), extend)
      );
    }

    return this.data.get(key);
  }

  public has(key: string) {
    return this.data.has(key);
  }

  public clear() {
    this.data.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
  }

  public size(): number {
    return this.data.size;
  }
}

export class ActiveCacheManager {
  private static caches: {
    [index: string]: ActiveCache;
  } = {};

  public static fetch(name: string, ttl?: number): ActiveCache {
    if (!this.caches[name]) {
      this.caches[name] = new ActiveCache(ttl);
    }
    return this.caches[name];
  }

  public static all(): ActiveCache[] {
    const caches = Object.keys(this.caches);
    const all = [];
    for (let i = caches.length; i--; ) {
      all.push(this.fetch(caches[i]));
    }
    return all;
  }
}
