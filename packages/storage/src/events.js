export const EVENT_PREFIX = "event:";
export async function eventsSince(db, lastEventId) {
    const after = EVENT_PREFIX + lastEventId;
    const result = (await db.allDocs({
        startkey: after,
        endkey: "event;",
        include_docs: true,
    }));
    const events = [];
    for (const row of result.rows) {
        const docId = row._id;
        if (!docId || !docId.startsWith(EVENT_PREFIX) || docId <= after) {
            continue;
        }
        const { _id, _rev, ...event } = row;
        events.push([docId.slice(EVENT_PREFIX.length), event]);
    }
    return events;
}
//# sourceMappingURL=events.js.map