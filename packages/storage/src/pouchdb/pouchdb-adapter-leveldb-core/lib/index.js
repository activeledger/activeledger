'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

require('crypto');
var levelup = _interopDefault(require('levelup'));
var sublevel = _interopDefault(require('sublevel-pouchdb'));
var through2 = require('through2');
var Deque = _interopDefault(require('double-ended-queue'));
var pouchdbAdapterUtils = require('pouchdb-adapter-utils');
var pouchdbMerge = require('pouchdb-merge');
require('pouchdb-binary-utils');
var pouchdbUtils = require('pouchdb-utils');
var pouchdbErrors = require('pouchdb-errors');

function mangle(key) {
  return '$' + key;
}
function unmangle(key) {
  return key.substring(1);
}
function Map$1() {
  this._store = {};
}
Map$1.prototype.get = function (key) {
  var mangled = mangle(key);
  return this._store[mangled];
};
Map$1.prototype.set = function (key, value) {
  var mangled = mangle(key);
  this._store[mangled] = value;
  return true;
};
Map$1.prototype.has = function (key) {
  var mangled = mangle(key);
  return mangled in this._store;
};
Map$1.prototype.delete = function (key) {
  var mangled = mangle(key);
  var res = mangled in this._store;
  delete this._store[mangled];
  return res;
};
Map$1.prototype.forEach = function (cb) {
  var keys = Object.keys(this._store);
  for (var i = 0, len = keys.length; i < len; i++) {
    var key = keys[i];
    var value = this._store[key];
    key = unmangle(key);
    cb(value, key);
  }
};
Object.defineProperty(Map$1.prototype, 'size', {
  get: function () {
    return Object.keys(this._store).length;
  }
});

function Set$1(array) {
  this._store = new Map$1();

  // init with an array
  if (array && Array.isArray(array)) {
    for (var i = 0, len = array.length; i < len; i++) {
      this.add(array[i]);
    }
  }
}
Set$1.prototype.add = function (key) {
  return this._store.set(key, true);
};
Set$1.prototype.has = function (key) {
  return this._store.has(key);
};
Set$1.prototype.forEach = function (cb) {
  this._store.forEach(function (value, key) {
    cb(key);
  });
};
Object.defineProperty(Set$1.prototype, 'size', {
  get: function () {
    return this._store.size;
  }
});

/* global Map,Set,Symbol */
// Based on https://kangax.github.io/compat-table/es6/ we can sniff out
// incomplete Map/Set implementations which would otherwise cause our tests to fail.
// Notably they fail in IE11 and iOS 8.4, which this prevents.
function supportsMapAndSet() {
  if (typeof Symbol === 'undefined' || typeof ExportedMap$$1 === 'undefined' || typeof ExportedSet$$1 === 'undefined') {
    return false;
  }
  var prop = Object.getOwnPropertyDescriptor(ExportedMap$$1, Symbol.species);
  return prop && 'get' in prop && ExportedMap$$1[Symbol.species] === ExportedMap$$1;
}

// based on https://github.com/montagejs/collections
/* global Map,Set */

var ExportedSet$$1;
var ExportedMap$$1;

{
  if (supportsMapAndSet()) { // prefer built-in Map/Set
    ExportedSet$$1 = ExportedSet$$1;
    ExportedMap$$1 = ExportedMap$$1;
  } else { // fall back to our polyfill
    ExportedSet$$1 = Set$1;
    ExportedMap$$1 = Map$1;
  }
}

function getCacheFor(transaction, store) {
  var prefix = store.prefix()[0];
  var cache = transaction._cache;
  var subCache = cache.get(prefix);
  if (!subCache) {
    subCache = new ExportedMap$$1();
    cache.set(prefix, subCache);
  }
  return subCache;
}

function LevelTransaction() {
  this._batch = [];
  this._cache = new ExportedMap$$1();
}

LevelTransaction.prototype.get = function (store, key, callback) {
  var cache = getCacheFor(this, store);
  var exists = cache.get(key);
  if (exists) {
    return pouchdbUtils.nextTick(function () {
      callback(null, exists);
    });
  } else if (exists === null) { // deleted marker
    /* istanbul ignore next */
    return pouchdbUtils.nextTick(function () {
      callback({name: 'NotFoundError'});
    });
  }
  store.get(key, function (err, res) {
    if (err) {
      /* istanbul ignore else */
      if (err.name === 'NotFoundError') {
        cache.set(key, null);
      }
      return callback(err);
    }
    cache.set(key, res);
    callback(null, res);
  });
};

LevelTransaction.prototype.batch = function (batch) {
  for (var i = 0, len = batch.length; i < len; i++) {
    var operation = batch[i];

    var cache = getCacheFor(this, operation.prefix);

    if (operation.type === 'put') {
      cache.set(operation.key, operation.value);
    } else {
      cache.set(operation.key, null);
    }
  }
  this._batch = this._batch.concat(batch);
};

LevelTransaction.prototype.execute = function (db, callback) {

  var keys = new ExportedSet$$1();
  var uniqBatches = [];

  // remove duplicates; last one wins
  for (var i = this._batch.length - 1; i >= 0; i--) {
    var operation = this._batch[i];
    var lookupKey = operation.prefix.prefix()[0] + '\xff' + operation.key;
    if (keys.has(lookupKey)) {
      continue;
    }
    keys.add(lookupKey);
    uniqBatches.push(operation);
  }

  db.batch(uniqBatches, callback);
};

var DOC_STORE = "document-store";
var BY_SEQ_STORE = "by-sequence";
var BINARY_STORE = "attach-binary-store";
var LOCAL_STORE = "local-store";
var META_STORE = "meta-store";

// leveldb barks if we try to open a db multiple times
// so we cache opened connections here for initstore()
var dbStores = new ExportedMap$$1();

// store the value of update_seq in the by-sequence store the key name will
// never conflict, since the keys in the by-sequence store are integers
var UPDATE_SEQ_KEY = "_local_last_update_seq";
var DOC_COUNT_KEY = "_local_doc_count";
var UUID_KEY = "_local_uuid";

var safeJsonEncoding = {
  encode: JSON.stringify,
  decode: JSON.parse,
  buffer: false,
  type: "cheap-json"
};

var levelChanges = new pouchdbUtils.changesHandler();

// winningRev and deleted are performance-killers, but
// in newer versions of PouchDB, they are cached on the metadata
function getWinningRev(metadata) {
  return "winningRev" in metadata
    ? metadata.winningRev
    : pouchdbMerge.winningRev(metadata);
}

function getIsDeleted(metadata, winningRev) {
  return "deleted" in metadata
    ? metadata.deleted
    : pouchdbAdapterUtils.isDeleted(metadata, winningRev);
}

function LevelPouch(opts, callback) {
  opts = pouchdbUtils.clone(opts);
  var api = this;
  var instanceId;
  var stores = {};
  var revLimit = opts.revs_limit;
  var db;
  var name = opts.name;
  // TODO: this is undocumented and unused probably
  /* istanbul ignore else */
  if (typeof opts.createIfMissing === "undefined") {
    opts.createIfMissing = true;
  }

  var leveldown = opts.db;

  var dbStore;
  var leveldownName = pouchdbUtils.functionName(leveldown);
  if (dbStores.has(leveldownName)) {
    dbStore = dbStores.get(leveldownName);
  } else {
    dbStore = new ExportedMap$$1();
    dbStores.set(leveldownName, dbStore);
  }
  if (dbStore.has(name)) {
    db = dbStore.get(name);
    afterDBCreated();
  } else {
    dbStore.set(
      name,
      sublevel(
        levelup(leveldown(name), opts, function(err) {
          /* istanbul ignore if */
          if (err) {
            dbStore.delete(name);
            return callback(err);
          }
          db = dbStore.get(name);
          db._docCount = -1;
          db._queue = new Deque();
          /* istanbul ignore else */
          if (typeof opts.migrate === "object") {
            // migration for leveldown
            opts.migrate.doMigrationOne(name, db, afterDBCreated);
          } else {
            afterDBCreated();
          }
        })
      )
    );
  }

  function afterDBCreated() {
    stores.docStore = db.sublevel(DOC_STORE, {
      valueEncoding: safeJsonEncoding
    });
    stores.bySeqStore = db.sublevel(BY_SEQ_STORE, { valueEncoding: "json" });
    stores.binaryStore = db.sublevel(BINARY_STORE, { valueEncoding: "binary" });
    stores.localStore = db.sublevel(LOCAL_STORE, { valueEncoding: "json" });
    stores.metaStore = db.sublevel(META_STORE, { valueEncoding: "json" });
    /* istanbul ignore else */
    if (typeof opts.migrate === "object") {
      // migration for leveldown
      opts.migrate.doMigrationTwo(db, stores, afterLastMigration);
    } else {
      afterLastMigration();
    }
  }

  function afterLastMigration() {
    stores.metaStore.get(UPDATE_SEQ_KEY, function(err, value) {
      if (typeof db._updateSeq === "undefined") {
        db._updateSeq = value || 0;
      }
      stores.metaStore.get(DOC_COUNT_KEY, function(err, value) {
        db._docCount = !err ? value : 0;
        stores.metaStore.get(UUID_KEY, function(err, value) {
          instanceId = !err ? value : pouchdbUtils.uuid();
          stores.metaStore.put(UUID_KEY, instanceId, function() {
            pouchdbUtils.nextTick(function() {
              callback(null, api);
            });
          });
        });
      });
    });
  }

  function countDocs(callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(new Error("database is closed"));
    }
    return callback(null, db._docCount); // use cached value
  }

  api._remote = false;
  /* istanbul ignore next */
  api.type = function() {
    return "leveldb";
  };

  api._id = function(callback) {
    callback(null, instanceId);
  };

  api._info = function(callback) {
    var res = {
      doc_count: db._docCount,
      update_seq: db._updateSeq,
      backend_adapter: pouchdbUtils.functionName(leveldown)
    };
    return pouchdbUtils.nextTick(function() {
      callback(null, res);
    });
  };

  function tryCode(fun, args) {
    try {
      fun.apply(null, args);
    } catch (err) {
      args[args.length - 1](err);
    }
  }

  function executeNext() {
    var firstTask = db._queue.peekFront();

    if (firstTask.type === "read") {
      runReadOperation(firstTask);
    } else {
      // write, only do one at a time
      runWriteOperation(firstTask);
    }
  }

  function runReadOperation(firstTask) {
    // do multiple reads at once simultaneously, because it's safe

    var readTasks = [firstTask];
    var i = 1;
    var nextTask = db._queue.get(i);
    while (typeof nextTask !== "undefined" && nextTask.type === "read") {
      readTasks.push(nextTask);
      i++;
      nextTask = db._queue.get(i);
    }

    var numDone = 0;

    readTasks.forEach(function(readTask) {
      var args = readTask.args;
      var callback = args[args.length - 1];
      args[args.length - 1] = pouchdbUtils.getArguments(function(cbArgs) {
        callback.apply(null, cbArgs);
        if (++numDone === readTasks.length) {
          pouchdbUtils.nextTick(function() {
            // all read tasks have finished
            readTasks.forEach(function() {
              db._queue.shift();
            });
            if (db._queue.length) {
              executeNext();
            }
          });
        }
      });
      tryCode(readTask.fun, args);
    });
  }

  function runWriteOperation(firstTask) {
    var args = firstTask.args;
    var callback = args[args.length - 1];
    args[args.length - 1] = pouchdbUtils.getArguments(function(cbArgs) {
      callback.apply(null, cbArgs);
      pouchdbUtils.nextTick(function() {
        db._queue.shift();
        if (db._queue.length) {
          executeNext();
        }
      });
    });
    tryCode(firstTask.fun, args);
  }

  // all read/write operations to the database are done in a queue,
  // similar to how websql/idb works. this avoids problems such
  // as e.g. compaction needing to have a lock on the database while
  // it updates stuff. in the future we can revisit this.
  function writeLock(fun) {
    return pouchdbUtils.getArguments(function(args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: "write"
      });

      if (db._queue.length === 1) {
        pouchdbUtils.nextTick(executeNext);
      }
    });
  }

  // same as the writelock, but multiple can run at once
  function readLock(fun) {
    return pouchdbUtils.getArguments(function(args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: "read"
      });

      if (db._queue.length === 1) {
        pouchdbUtils.nextTick(executeNext);
      }
    });
  }

  function formatSeq(n) {
    return ("0000000000000000" + n).slice(-16);
  }

  function parseSeq(s) {
    return parseInt(s, 10);
  }

  api._get = readLock(function(id, opts, callback) {
    opts = pouchdbUtils.clone(opts);

    stores.docStore.get(id, function(err, metadata) {
      if (err || !metadata) {
        return callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, "missing"));
      }

      var rev;
      if (!opts.rev) {
        rev = getWinningRev(metadata);
        var deleted = getIsDeleted(metadata, rev);
        if (deleted) {
          return callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, "deleted"));
        }
      } else {
        rev = opts.latest ? pouchdbMerge.latest(opts.rev, metadata) : opts.rev;
      }

      var seq = metadata.rev_map[rev];

      stores.bySeqStore.get(formatSeq(seq), function(err, doc) {
        if (!doc) {
          return callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
        }
        /* istanbul ignore if */
        if ("_id" in doc && doc._id !== metadata.id) {
          // this failing implies something very wrong
          return callback(new Error("wrong doc returned"));
        }
        doc._id = metadata.id;
        if ("_rev" in doc) {
          /* istanbul ignore if */
          if (doc._rev !== rev) {
            // this failing implies something very wrong
            return callback(new Error("wrong doc returned"));
          }
        } else {
          // we didn't always store this
          doc._rev = rev;
        }
        return callback(null, { doc: doc, metadata: metadata });
      });
    });
  });

  api._bulkDocs = writeLock(function(req, opts, callback) {
    var newEdits = opts.new_edits;
    var results = new Array(req.docs.length);
    var fetchedDocs = new ExportedMap$$1();
    var stemmedRevs = new ExportedMap$$1();

    var txn = new LevelTransaction();
    var docCountDelta = 0;
    var newUpdateSeq = db._updateSeq;

    // parse the docs and give each a sequence number
    var userDocs = req.docs;
    var docInfos = userDocs.map(function(doc) {
      if (doc._id && pouchdbAdapterUtils.isLocalId(doc._id)) {
        return doc;
      }
      var newDoc = pouchdbAdapterUtils.parseDoc(doc, newEdits, api.__opts);

      if (newDoc.metadata && !newDoc.metadata.rev_map) {
        newDoc.metadata.rev_map = {};
      }

      return newDoc;
    });
    var infoErrors = docInfos.filter(function(doc) {
      return doc.error;
    });

    if (infoErrors.length) {
      return callback(infoErrors[0]);
    }

    function fetchExistingDocs(finish) {
      var numDone = 0;
      var overallErr;
      function checkDone() {
        if (++numDone === userDocs.length) {
          return finish(overallErr);
        }
      }

      userDocs.forEach(function(doc) {
        if (doc._id && pouchdbAdapterUtils.isLocalId(doc._id)) {
          // skip local docs
          return checkDone();
        }
        txn.get(stores.docStore, doc._id, function(err, info) {
          if (err) {
            /* istanbul ignore if */
            if (err.name !== "NotFoundError") {
              overallErr = err;
            }
          } else {
            fetchedDocs.set(doc._id, info);
          }
          checkDone();
        });
      });
    }

    function compact(revsMap, callback) {
      var promise = Promise.resolve();
      revsMap.forEach(function(revs, docId) {
        // TODO: parallelize, for now need to be sequential to
        // pass orphaned attachment tests
        promise = promise.then(function() {
          return new Promise(function(resolve, reject) {
            api._doCompactionNoLock(docId, revs, { ctx: txn }, function(err) {
              /* istanbul ignore if */
              if (err) {
                return reject(err);
              }
              resolve();
            });
          });
        });
      });

      promise.then(function() {
        callback();
      }, callback);
    }

    function autoCompact(callback) {
      var revsMap = new ExportedMap$$1();
      fetchedDocs.forEach(function(metadata, docId) {
        revsMap.set(docId, pouchdbMerge.compactTree(metadata));
      });
      compact(revsMap, callback);
    }

    function finish() {
      compact(stemmedRevs, function(error) {
        /* istanbul ignore if */
        if (error) {
          complete(error);
        }
        if (api.auto_compaction) {
          return autoCompact(complete);
        }
        complete();
      });
    }

    function writeDoc(
      docInfo,
      winningRev,
      winningRevIsDeleted,
      newRevIsDeleted,
      isUpdate,
      delta,
      resultsIdx,
      callback2
    ) {
      docCountDelta += delta;

      docInfo.metadata.winningRev = winningRev;
      docInfo.metadata.deleted = winningRevIsDeleted;

      docInfo.data._id = docInfo.metadata.id;
      docInfo.data._rev = docInfo.metadata.rev;

      if (newRevIsDeleted) {
        docInfo.data._deleted = true;
      }

      if (docInfo.stemmedRevs.length) {
        stemmedRevs.set(docInfo.metadata.id, docInfo.stemmedRevs);
      }

      function finish() {
        var seq = docInfo.metadata.rev_map[docInfo.metadata.rev];
        /* istanbul ignore if */
        if (seq) {
          // check that there aren't any existing revisions with the same
          // revision id, else we shouldn't do anything
          return callback2();
        }
        seq = ++newUpdateSeq;
        docInfo.metadata.rev_map[
          docInfo.metadata.rev
        ] = docInfo.metadata.seq = seq;
        var seqKey = formatSeq(seq);
        var batch = [
          {
            key: seqKey,
            value: docInfo.data,
            prefix: stores.bySeqStore,
            type: "put"
          },
          {
            key: docInfo.metadata.id,
            value: docInfo.metadata,
            prefix: stores.docStore,
            type: "put"
          }
        ];
        txn.batch(batch);
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: docInfo.metadata.rev
        };
        fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
        callback2();
      }

      finish();
    }

    function complete(err) {
      /* istanbul ignore if */
      if (err) {
        return pouchdbUtils.nextTick(function() {
          callback(err);
        });
      }
      txn.batch([
        {
          prefix: stores.metaStore,
          type: "put",
          key: UPDATE_SEQ_KEY,
          value: newUpdateSeq
        },
        {
          prefix: stores.metaStore,
          type: "put",
          key: DOC_COUNT_KEY,
          value: db._docCount + docCountDelta
        }
      ]);
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        db._docCount += docCountDelta;
        db._updateSeq = newUpdateSeq;
        levelChanges.notify(name);
        pouchdbUtils.nextTick(function() {
          callback(null, results);
        });
      });
    }

    if (!docInfos.length) {
      return callback(null, []);
    }


    fetchExistingDocs(function (err) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      pouchdbAdapterUtils.processDocs(revLimit, docInfos, api, fetchedDocs, txn, results,
                  writeDoc, opts, finish);
    });    

  });
  api._allDocs = function(opts, callback) {
    if ("keys" in opts) {
      return pouchdbAdapterUtils.allDocsKeysQuery(this, opts);
    }
    return readLock(function(opts, callback) {
      opts = pouchdbUtils.clone(opts);
      countDocs(function(err, docCount) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        var readstreamOpts = {};
        var skip = opts.skip || 0;
        if (opts.startkey) {
          readstreamOpts.gte = opts.startkey;
        }
        if (opts.endkey) {
          readstreamOpts.lte = opts.endkey;
        }
        if (opts.key) {
          readstreamOpts.gte = readstreamOpts.lte = opts.key;
        }
        if (opts.descending) {
          readstreamOpts.reverse = true;
          // switch start and ends
          var tmp = readstreamOpts.lte;
          readstreamOpts.lte = readstreamOpts.gte;
          readstreamOpts.gte = tmp;
        }
        var limit;
        if (typeof opts.limit === "number") {
          limit = opts.limit;
        }
        if (
          limit === 0 ||
          ("gte" in readstreamOpts &&
            "lte" in readstreamOpts &&
            readstreamOpts.gte > readstreamOpts.lte)
        ) {
          // should return 0 results when start is greater than end.
          // normally level would "fix" this for us by reversing the order,
          // so short-circuit instead
          var returnVal = {
            total_rows: docCount,
            offset: opts.skip,
            rows: []
          };
          /* istanbul ignore if */
          if (opts.update_seq) {
            returnVal.update_seq = db._updateSeq;
          }
          return callback(null, returnVal);
        }
        var results = [];
        var docstream = stores.docStore.readStream(readstreamOpts);

        var throughStream = through2.obj(
          function(entry, _, next) {
            var metadata = entry.value;
            // winningRev and deleted are performance-killers, but
            // in newer versions of PouchDB, they are cached on the metadata
            var winningRev = getWinningRev(metadata);
            var deleted = getIsDeleted(metadata, winningRev);
            if (!deleted) {
              if (skip-- > 0) {
                next();
                return;
              } else if (typeof limit === "number" && limit-- <= 0) {
                docstream.unpipe();
                docstream.destroy();
                next();
                return;
              }
            } else if (opts.deleted !== "ok") {
              next();
              return;
            }
            function allDocsInner(data) {
              var doc = {
                id: metadata.id,
                key: metadata.id,
                value: {
                  rev: winningRev
                }
              };
              if (opts.include_docs) {
                doc.doc = data;
                doc.doc._rev = doc.value.rev;
                if (opts.conflicts) {
                  var conflicts = pouchdbMerge.collectConflicts(metadata);
                  if (conflicts.length) {
                    doc.doc._conflicts = conflicts;
                  }
                }
              }
              if (opts.inclusive_end === false && metadata.id === opts.endkey) {
                return next();
              } else if (deleted) {
                if (opts.deleted === "ok") {
                  doc.value.deleted = true;
                  doc.doc = null;
                } else {
                  /* istanbul ignore next */
                  return next();
                }
              }
              results.push(doc);
              next();
            }
            if (opts.include_docs) {
              var seq = metadata.rev_map[winningRev];
              stores.bySeqStore.get(formatSeq(seq), function(err, data) {
                allDocsInner(data);
              });
            } else {
              allDocsInner();
            }
          },
          function(next) {
            Promise.resolve().then(function() {
              var returnVal = {
                total_rows: docCount,
                offset: opts.skip,
                rows: results
              };

              /* istanbul ignore if */
              if (opts.update_seq) {
                returnVal.update_seq = db._updateSeq;
              }
              callback(null, returnVal);
            }, callback);
            next();
          }
        ).on("unpipe", function() {
          throughStream.end();
        });

        docstream.on("error", callback);

        docstream.pipe(throughStream);
      });
    })(opts, callback);
  };

  api._changes = function(opts) {
    opts = pouchdbUtils.clone(opts);

    if (opts.continuous) {
      var id = name + ":" + pouchdbUtils.uuid();
      levelChanges.addListener(name, id, api, opts);
      levelChanges.notify(name);
      return {
        cancel: function() {
          levelChanges.removeListener(name, id);
        }
      };
    }

    var descending = opts.descending;
    var results = [];
    var lastSeq = opts.since || 0;
    var called = 0;
    var streamOpts = {
      reverse: descending
    };
    var limit;
    if ("limit" in opts && opts.limit > 0) {
      limit = opts.limit;
    }
    if (!streamOpts.reverse) {
      streamOpts.start = formatSeq(opts.since || 0);
    }

    var docIds = opts.doc_ids && new ExportedSet$$1(opts.doc_ids);
    var filter = pouchdbUtils.filterChange(opts);
    var docIdsToMetadata = new ExportedMap$$1();

    function complete() {
      opts.done = true;
      if (opts.return_docs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }
      changeStream.unpipe(throughStream);
      changeStream.destroy();
      if (!opts.continuous && !opts.cancelled) {
        opts.complete(null, { results: results, last_seq: lastSeq });
      }
    }
    var changeStream = stores.bySeqStore.readStream(streamOpts);
    var throughStream = through2.obj(
      function(data, _, next) {
        if (limit && called >= limit) {
          complete();
          return next();
        }
        if (opts.cancelled || opts.done) {
          return next();
        }

        var seq = parseSeq(data.key);
        var doc = data.value;

        if (seq === opts.since && !descending) {
          // couchdb ignores `since` if descending=true
          return next();
        }

        if (docIds && !docIds.has(doc._id)) {
          return next();
        }

        var metadata;

        function onGetMetadata(metadata) {
          var winningRev = getWinningRev(metadata);

          function onGetWinningDoc(winningDoc) {
            var change = opts.processChange(winningDoc, metadata, opts);
            change.seq = metadata.seq;

            var filtered = filter(change);
            if (typeof filtered === "object") {
              return opts.complete(filtered);
            }

            if (filtered) {
              called++;

              opts.onChange(change);

              if (opts.return_docs) {
                results.push(change);
              }
            }
            next();
          }

          if (metadata.seq !== seq) {
            // some other seq is later
            return next();
          }

          lastSeq = seq;

          if (winningRev === doc._rev) {
            return onGetWinningDoc(doc);
          }

          // fetch the winner

          var winningSeq = metadata.rev_map[winningRev];

          stores.bySeqStore.get(formatSeq(winningSeq), function(err, doc) {
            onGetWinningDoc(doc);
          });
        }

        metadata = docIdsToMetadata.get(doc._id);
        if (metadata) {
          // cached
          return onGetMetadata(metadata);
        }
        // metadata not cached, have to go fetch it
        stores.docStore.get(doc._id, function(err, metadata) {
          /* istanbul ignore if */
          if (
            opts.cancelled ||
            opts.done ||
            db.isClosed() ||
            pouchdbAdapterUtils.isLocalId(metadata.id)
          ) {
            return next();
          }
          docIdsToMetadata.set(doc._id, metadata);
          onGetMetadata(metadata);
        });
      },
      function(next) {
        if (opts.cancelled) {
          return next();
        }
        if (opts.return_docs && opts.limit) {
          /* istanbul ignore if */
          if (opts.limit < results.length) {
            results.length = opts.limit;
          }
        }

        next();
      }
    ).on("unpipe", function() {
      throughStream.end();
      complete();
    });
    changeStream.pipe(throughStream);
    return {
      cancel: function() {
        opts.cancelled = true;
        complete();
      }
    };
  };

  api._close = function(callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(pouchdbErrors.createError(pouchdbErrors.NOT_OPEN));
    }
    db.close(function(err) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        dbStore.delete(name);
        callback();
      }
    });
  };

  api._getRevisionTree = function(docId, callback) {
    stores.docStore.get(docId, function(err, metadata) {
      if (err) {
        callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
      } else {
        callback(null, metadata.rev_tree);
      }
    });
  };

  api._doCompaction = writeLock(function(docId, revs, opts, callback) {
    api._doCompactionNoLock(docId, revs, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._doCompactionNoLock = function(docId, revs, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }

    if (!revs.length) {
      return callback();
    }
    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.docStore, docId, function(err, metadata) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      var seqs = revs.map(function(rev) {
        var seq = metadata.rev_map[rev];
        delete metadata.rev_map[rev];
        return seq;
      });
      pouchdbMerge.traverseRevTree(metadata.rev_tree, function(
        isLeaf,
        pos,
        revHash,
        ctx,
        opts
      ) {
        var rev = pos + "-" + revHash;
        if (revs.indexOf(rev) !== -1) {
          opts.status = "missing";
        }
      });

      var batch = [];
      batch.push({
        key: metadata.id,
        value: metadata,
        type: "put",
        prefix: stores.docStore
      });
      var numDone = 0;
      var overallErr;
      function checkDone(err) {
        /* istanbul ignore if */
        if (err) {
          overallErr = err;
        }
        if (++numDone === revs.length) {
          // done
          /* istanbul ignore if */
          if (overallErr) {
            return callback(overallErr);
          }
        }
      }

      seqs.forEach(function(seq) {
        batch.push({
          key: formatSeq(seq),
          type: "del",
          prefix: stores.bySeqStore
        });
        txn.get(stores.bySeqStore, formatSeq(seq), function(err, doc) {
          /* istanbul ignore if */
          if (err) {
            if (err.name === "NotFoundError") {
              return checkDone();
            } else {
              return checkDone(err);
            }
          }
          checkDone();
        });
      });
    });
  };

  api._getLocal = function(id, callback) {
    stores.localStore.get(id, function(err, doc) {
      if (err) {
        callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
      } else {
        callback(null, doc);
      }
    });
  };

  api._putLocal = function(doc, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._putLocalNoLock(doc, opts, callback);
    } else {
      api._putLocalWithLock(doc, opts, callback);
    }
  };

  api._putLocalWithLock = writeLock(function(doc, opts, callback) {
    api._putLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._putLocalNoLock = function(doc, opts, callback) {
    delete doc._revisions; // ignore this, trust the rev
    var oldRev = doc._rev;
    var id = doc._id;

    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.localStore, id, function(err, resp) {
      if (err && oldRev) {
        return callback(pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT));
      }
      if (resp && resp._rev !== oldRev) {
        return callback(pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT));
      }
      doc._rev = oldRev
        ? "0-" + (parseInt(oldRev.split("-")[1], 10) + 1)
        : "0-1";
      var batch = [
        {
          type: "put",
          prefix: stores.localStore,
          key: id,
          value: doc
        }
      ];

      txn.batch(batch);
      var ret = { ok: true, id: doc._id, rev: doc._rev };

      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  api._removeLocal = function(doc, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._removeLocalNoLock(doc, opts, callback);
    } else {
      api._removeLocalWithLock(doc, opts, callback);
    }
  };

  api._removeLocalWithLock = writeLock(function(doc, opts, callback) {
    api._removeLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._removeLocalNoLock = function(doc, opts, callback) {
    var txn = opts.ctx || new LevelTransaction();
    txn.get(stores.localStore, doc._id, function(err, resp) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== "NotFoundError") {
          return callback(err);
        } else {
          return callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
        }
      }
      if (resp._rev !== doc._rev) {
        return callback(pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT));
      }
      txn.batch([
        {
          prefix: stores.localStore,
          type: "del",
          key: doc._id
        }
      ]);
      var ret = { ok: true, id: doc._id, rev: "0-0" };
      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  // close and delete open leveldb stores
  api._destroy = function(opts, callback) {
    var dbStore;
    var leveldownName = pouchdbUtils.functionName(leveldown);
    /* istanbul ignore else */
    if (dbStores.has(leveldownName)) {
      dbStore = dbStores.get(leveldownName);
    } else {
      return callDestroy(name, callback);
    }

    /* istanbul ignore else */
    if (dbStore.has(name)) {
      levelChanges.removeAllListeners(name);

      dbStore.get(name).close(function() {
        dbStore.delete(name);
        callDestroy(name, callback);
      });
    } else {
      callDestroy(name, callback);
    }
  };
  function callDestroy(name, cb) {
    // May not exist if leveldown is backed by memory adapter
    /* istanbul ignore else */
    if ("destroy" in leveldown) {
      leveldown.destroy(name, cb);
    } else {
      cb(null);
    }
  }
}

module.exports = LevelPouch;
