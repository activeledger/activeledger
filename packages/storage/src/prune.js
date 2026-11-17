export const PRUNE_KINDS = ["umid", "fail", "event", "error"];
export const DEFAULT_PAGE_LIMIT = 5000;
export const MAX_PAGE_LIMIT = 20000;
export const PAGE_BUDGET_MS = 2000;
export const MIN_AGE_MS = 60 * 60 * 1000;
const TIME_KEYED = /^(umid|fail):(\d{13}),/;
const EVENT = /^event:(\d{13})[-,]/;
const ERROR = /^[0-9a-f]{64}:(\d{13})$/;
export function idTime(kind, id) {
    let match = null;
    if (kind === "umid" || kind === "fail") {
        match = TIME_KEYED.exec(id);
        if (!match || match[1] !== kind)
            return undefined;
        return Number(match[2]);
    }
    if (kind === "event") {
        match = EVENT.exec(id);
        return match ? Number(match[1]) : undefined;
    }
    match = ERROR.exec(id);
    return match ? Number(match[1]) : undefined;
}
export function idRange(kind) {
    switch (kind) {
        case "umid":
            return { gte: "umid:", lt: "umid;", ordered: true };
        case "fail":
            return { gte: "fail:", lt: "fail;", ordered: true };
        case "event":
            return { gte: "event:", lt: "event;", ordered: true };
        default:
            return { gte: "0", lt: "g", ordered: false };
    }
}
export function checkPruneRequest(body, now = Date.now()) {
    const b = body;
    if (!b || typeof b !== "object")
        return { ok: false, error: "a prune request is an object" };
    if (!PRUNE_KINDS.includes(b.kind))
        return { ok: false, error: `kind must be one of ${PRUNE_KINDS.join(", ")}` };
    if (typeof b.before !== "number" || !Number.isFinite(b.before) || b.before <= 0)
        return { ok: false, error: "before must be a time in milliseconds" };
    if (b.before > now - MIN_AGE_MS)
        return { ok: false, error: "before must be at least an hour ago" };
    if (b.after !== undefined && typeof b.after !== "string")
        return { ok: false, error: "after must be an id" };
    let limit = DEFAULT_PAGE_LIMIT;
    if (b.limit !== undefined) {
        if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1)
            return { ok: false, error: "limit must be a whole number of at least 1" };
        limit = Math.min(b.limit, MAX_PAGE_LIMIT);
    }
    return {
        ok: true,
        request: {
            kind: b.kind,
            before: b.before,
            after: b.after,
            limit,
            dryRun: b.dryRun === true,
            requireProcessed: b.requireProcessed !== false,
        },
    };
}
//# sourceMappingURL=prune.js.map