export class Cache {
    ttl;
    data;
    timers;
    constructor(ttl = 1200000) {
        this.ttl = ttl;
        this.data = new Map();
        this.timers = new Map();
    }
    set(key, value, ttl) {
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
        }
        this.timers.set(key, setTimeout(() => this.delete(key), ttl ?? this.ttl));
        this.data.set(key, value);
    }
    delete(key) {
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
            this.timers.delete(key);
        }
        this.data.delete(key);
    }
    get(key, extend) {
        const value = this.data.get(key);
        if (value && extend) {
            this.set(key, value, extend);
        }
        return value;
    }
    has(key) {
        return this.data.has(key);
    }
    clear() {
        this.data.clear();
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }
    size() {
        return this.data.size;
    }
}
export class CacheManager {
    static caches = {};
    static fetch(name, ttl) {
        if (!this.caches[name]) {
            this.caches[name] = new Cache(ttl);
        }
        return this.caches[name];
    }
    static all() {
        return Object.values(this.caches);
    }
}
//# sourceMappingURL=cache.js.map