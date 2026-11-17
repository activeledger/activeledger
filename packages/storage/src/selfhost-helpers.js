import { randomUUID } from "crypto";
export const isValidDbName = (name) => /^activeledger[A-Za-z0-9_-]{0,64}$/.test(name);
export const checkDoc = (doc) => {
    if (!doc._id)
        doc._id = randomUUID();
    return doc;
};
export const prepareAllDocs = (options) => {
    if (options.limit) {
        options.limit = parseInt(options.limit) || null;
    }
    if (options.startkey) {
        options.startkey = options.startkey.replace(/"/g, "");
    }
    if (options.endkey) {
        options.endkey = options.endkey.replace(/"/g, "");
        options.endkey = options.endkey.slice(0, -1) + "香";
    }
    if (options.keys) {
        options.keys = options.keys.map((id) => filterPrefix(id));
    }
    return options;
};
export const filterPrefix = (stream, db) => {
    if (db && db !== 'activeledger') {
        return stream;
    }
    else {
        let [streamId, suffix] = stream.split(":");
        if (streamId.length > 64 && !streamId.startsWith("0x")) {
            streamId = streamId.slice(-64);
        }
        if (suffix) {
            return streamId + ":" + suffix;
        }
        return streamId;
    }
};
//# sourceMappingURL=selfhost-helpers.js.map