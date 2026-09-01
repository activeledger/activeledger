const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getStream, getStreams } = require("../lib/routes/stream.js");
const { getTransaction } = require("../lib/routes/tx.js");

/**
 * Live-confirmed against the real devnet: ActiveDSConnect.get() on a
 * missing key does NOT reject on the self-hosted LevelDB backend -
 * ActiveRequest.send() never rejects on a non-2xx HTTP status (this
 * session's own earlier finding), so a 500 response with a
 * `{notFound: true, code: "LEVEL_NOT_FOUND"}` body resolves successfully
 * instead of throwing. getStream()/getTransaction() must detect this via
 * looksLikeDoc(), not just try/catch.
 */
function fakeDbThatLeaksNotFoundInstead(realDocsById) {
  return {
    async get(id) {
      const doc = realDocsById[id];
      if (doc) return doc;
      return { notFound: true, code: "LEVEL_NOT_FOUND" }; // resolves, does not reject
    },
    async allDocs({ keys }) {
      const rows = keys.filter((k) => realDocsById[k]).map((k) => ({ id: k, doc: realDocsById[k] }));
      return { rows };
    },
  };
}

test("getStream: a LevelDB not-found object that resolves instead of rejecting still comes back as null, not leaked to the caller", async () => {
  const db = fakeDbThatLeaksNotFoundInstead({});
  const result = await getStream({ url: ["api", "stream", "missing-id"] }, db);
  assert.deepEqual(result, { stream: null });
});

test("getStream: a real doc still comes through correctly", async () => {
  const db = fakeDbThatLeaksNotFoundInstead({ "real-id": { _id: "real-id", _rev: "1-a", count: 4 } });
  const result = await getStream({ url: ["api", "stream", "real-id"] }, db);
  assert.deepEqual(result, { stream: { _id: "real-id", _rev: "1-a", count: 4 } });
});

test("getTransaction: same leaked-not-found shape comes back as null, not passed through", async () => {
  const db = fakeDbThatLeaksNotFoundInstead({});
  const result = await getTransaction({ url: ["api", "tx", "missing-umid"] }, db);
  assert.deepEqual(result, { transaction: null });
});

test("getTransaction: a real umid doc's compact entry comes through correctly", async () => {
  const db = fakeDbThatLeaksNotFoundInstead({
    "real-umid:umid": { _id: "real-umid:umid", _rev: "1-a", umid: { $umid: "real-umid", $tx: {} } },
  });
  const result = await getTransaction({ url: ["api", "tx", "real-umid"] }, db);
  assert.deepEqual(result, { transaction: { $umid: "real-umid", $tx: {} } });
});

test("getStreams: the batch/allDocs path already excludes missing keys correctly (live-confirmed, no fix needed there)", async () => {
  const db = fakeDbThatLeaksNotFoundInstead({ a: { _id: "a", _rev: "1-a" } });
  const result = await getStreams({ body: ["a", "missing"] }, db);
  assert.deepEqual(result, { streams: [{ _id: "a", _rev: "1-a" }] });
});
