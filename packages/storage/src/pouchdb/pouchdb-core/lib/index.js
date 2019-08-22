'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var pouchdbMerge = require('pouchdb-merge');
var pouchdbErrors = require('pouchdb-errors');
var pouchdbUtils = require('pouchdb-utils');
var inherits = _interopDefault(require('inherits'));
var events = require('events');

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

inherits(Changes, events.EventEmitter);

function tryCatchInChangeListener(self, change, pending, lastSeq) {
  // isolate try/catches to avoid V8 deoptimizations
  try {
    self.emit('change', change, pending, lastSeq);
  } catch (e) {
    pouchdbUtils.guardedConsole('error', 'Error in .on("change", function):', e);
  }
}

function Changes(db, opts, callback) {
  events.EventEmitter.call(this);
  var self = this;
  this.db = db;
  opts = opts ? pouchdbUtils.clone(opts) : {};
  var complete = opts.complete = pouchdbUtils.once(function (err, resp) {
    if (err) {
      if (pouchdbUtils.listenerCount(self, 'error') > 0) {
        self.emit('error', err);
      }
    } else {
      self.emit('complete', resp);
    }
    self.removeAllListeners();
    db.removeListener('destroyed', onDestroy);
  });
  if (callback) {
    self.on('complete', function (resp) {
      callback(null, resp);
    });
    self.on('error', callback);
  }
  function onDestroy() {
    self.cancel();
  }
  db.once('destroyed', onDestroy);

  opts.onChange = function (change, pending, lastSeq) {
    /* istanbul ignore if */
    if (self.isCancelled) {
      return;
    }
    tryCatchInChangeListener(self, change, pending, lastSeq);
  };

  var promise = new Promise(function (fulfill, reject) {
    opts.complete = function (err, res) {
      if (err) {
        reject(err);
      } else {
        fulfill(res);
      }
    };
  });
  self.once('cancel', function () {
    db.removeListener('destroyed', onDestroy);
    opts.complete(null, {status: 'cancelled'});
  });
  this.then = promise.then.bind(promise);
  this['catch'] = promise['catch'].bind(promise);
  this.then(function (result) {
    complete(null, result);
  }, complete);



  if (!db.taskqueue.isReady) {
    db.taskqueue.addTask(function (failed) {
      if (failed) {
        opts.complete(failed);
      } else if (self.isCancelled) {
        self.emit('cancel');
      } else {
        self.validateChanges(opts);
      }
    });
  } else {
    self.validateChanges(opts);
  }
}
Changes.prototype.cancel = function () {
  this.isCancelled = true;
  if (this.db.taskqueue.isReady) {
    this.emit('cancel');
  }
};
function processChange(doc, metadata, opts) {
  var changeList = [{rev: doc._rev}];
  if (opts.style === 'all_docs') {
    changeList = pouchdbMerge.collectLeaves(metadata.rev_tree)
    .map(function (x) { return {rev: x.rev}; });
  }
  var change = {
    id: metadata.id,
    changes: changeList,
    doc: doc
  };

  if (pouchdbMerge.isDeleted(metadata, doc._rev)) {
    change.deleted = true;
  }
  if (opts.conflicts) {
    change.doc._conflicts = pouchdbMerge.collectConflicts(metadata);
    if (!change.doc._conflicts.length) {
      delete change.doc._conflicts;
    }
  }
  return change;
}

Changes.prototype.validateChanges = function (opts) {
  var callback = opts.complete;
  var self = this;

  /* istanbul ignore else */
  if (PouchDB._changesFilterPlugin) {
    PouchDB._changesFilterPlugin.validate(opts, function (err) {
      if (err) {
        return callback(err);
      }
      self.doChanges(opts);
    });
  } else {
    self.doChanges(opts);
  }
};

Changes.prototype.doChanges = function (opts) {
  var self = this;
  var callback = opts.complete;

  opts = pouchdbUtils.clone(opts);
  if ('live' in opts && !('continuous' in opts)) {
    opts.continuous = opts.live;
  }
  opts.processChange = processChange;

  if (opts.since === 'latest') {
    opts.since = 'now';
  }
  if (!opts.since) {
    opts.since = 0;
  }
  if (opts.since === 'now') {
    this.db.info().then(function (info) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        callback(null, {status: 'cancelled'});
        return;
      }
      opts.since = info.update_seq;
      self.doChanges(opts);
    }, callback);
    return;
  }

  /* istanbul ignore else */
  if (PouchDB._changesFilterPlugin) {
    PouchDB._changesFilterPlugin.normalize(opts);
    if (PouchDB._changesFilterPlugin.shouldFilter(this, opts)) {
      return PouchDB._changesFilterPlugin.filter(this, opts);
    }
  } else {
    ['doc_ids', 'filter', 'selector', 'view'].forEach(function (key) {
      if (key in opts) {
        pouchdbUtils.guardedConsole('warn',
          'The "' + key + '" option was passed in to changes/replicate, ' +
          'but pouchdb-changes-filter plugin is not installed, so it ' +
          'was ignored. Please install the plugin to enable filtering.'
        );
      }
    });
  }

  if (!('descending' in opts)) {
    opts.descending = false;
  }

  // 0 and 1 should return 1 document
  opts.limit = opts.limit === 0 ? 1 : opts.limit;
  opts.complete = callback;
  var newPromise = this.db._changes(opts);
  /* istanbul ignore else */
  if (newPromise && typeof newPromise.cancel === 'function') {
    var cancel = self.cancel;
    self.cancel = pouchdbUtils.getArguments(function (args) {
      newPromise.cancel();
      cancel.apply(this, args);
    });
  }
};

/*
 * A generic pouch adapter
 */

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Wrapper for functions that call the bulkdocs api with a single doc,
// if the first result is an error, return an error
function yankError(callback, docId) {
  return function(err, results) {
    if (err || (results[0] && results[0].error)) {
      err = err || results[0];
      err.docId = docId;
      callback(err);
    } else {
      callback(null, results.length ? results[0] : results);
    }
  };
}

// clean docs given to us by the user
function cleanDocs(docs) {}

// compare two docs, first by _id then by _rev
function compareByIdThenRev(a, b) {
  var idCompare = compare(a._id, b._id);
  if (idCompare !== 0) {
    return idCompare;
  }
  var aStart = a._revisions ? a._revisions.start : 0;
  var bStart = b._revisions ? b._revisions.start : 0;
  return compare(aStart, bStart);
}

// for every node in a revision tree computes its distance from the closest
// leaf
function computeHeight(revs) {
  var height = {};
  var edges = [];
  pouchdbMerge.traverseRevTree(revs, function(isLeaf, pos, id, prnt) {
    var rev = pos + "-" + id;
    if (isLeaf) {
      height[rev] = 0;
    }
    if (prnt !== undefined) {
      edges.push({ from: prnt, to: rev });
    }
    return rev;
  });

  edges.reverse();
  edges.forEach(function(edge) {
    if (height[edge.from] === undefined) {
      height[edge.from] = 1 + height[edge.to];
    } else {
      height[edge.from] = Math.min(height[edge.from], 1 + height[edge.to]);
    }
  });
  return height;
}

function allDocsKeysParse(opts) {
  var keys =
    "limit" in opts
      ? opts.keys.slice(opts.skip, opts.limit + opts.skip)
      : opts.skip > 0
      ? opts.keys.slice(opts.skip)
      : opts.keys;
  opts.keys = keys;
  opts.skip = 0;
  delete opts.limit;
  if (opts.descending) {
    keys.reverse();
    opts.descending = false;
  }
}

// all compaction is done in a queue, to avoid attaching
// too many listeners at once
function doNextCompaction(self) {
  var task = self._compactionQueue[0];
  var opts = task.opts;
  var callback = task.callback;
  self
    .get("_local/compaction")
    .catch(function() {
      return false;
    })
    .then(function(doc) {
      if (doc && doc.last_seq) {
        opts.last_seq = doc.last_seq;
      }
      self._compact(opts, function(err, res) {
        /* istanbul ignore if */
        if (err) {
          callback(err);
        } else {
          callback(null, res);
        }
        pouchdbUtils.nextTick(function() {
          self._compactionQueue.shift();
          if (self._compactionQueue.length) {
            doNextCompaction(self);
          }
        });
      });
    });
}

inherits(AbstractPouchDB, events.EventEmitter);

function AbstractPouchDB() {
  events.EventEmitter.call(this);

  // re-bind prototyped methods
  for (var p in AbstractPouchDB.prototype) {
    if (typeof this[p] === "function") {
      this[p] = this[p].bind(this);
    }
  }
}

AbstractPouchDB.prototype.post = pouchdbUtils.adapterFun("post", function(
  doc,
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return callback(pouchdbErrors.createError(pouchdbErrors.NOT_AN_OBJECT));
  }
  this.bulkDocs({ docs: [doc] }, opts, yankError(callback, doc._id));
});

AbstractPouchDB.prototype.put = pouchdbUtils.adapterFun("put", function(doc, opts, cb) {
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return cb(pouchdbErrors.createError(pouchdbErrors.NOT_AN_OBJECT));
  }
  pouchdbUtils.invalidIdError(doc._id);
  if (pouchdbMerge.isLocalId(doc._id) && typeof this._putLocal === "function") {
    if (doc._deleted) {
      return this._removeLocal(doc, cb);
    } else {
      return this._putLocal(doc, cb);
    }
  }
  var self = this;
  if (opts.force && doc._rev) {
    transformForceOptionToNewEditsOption();
    putDoc(function(err) {
      var result = err ? null : { ok: true, id: doc._id, rev: doc._rev };
      cb(err, result);
    });
  } else {
    putDoc(cb);
  }

  function transformForceOptionToNewEditsOption() {
    var parts = doc._rev.split("-");
    var oldRevId = parts[1];
    var oldRevNum = parseInt(parts[0], 10);

    var newRevNum = oldRevNum + 1;
    var newRevId = pouchdbUtils.rev();

    doc._revisions = {
      start: newRevNum,
      ids: [newRevId, oldRevId]
    };
    doc._rev = newRevNum + "-" + newRevId;
    opts.new_edits = false;
  }
  function putDoc(next) {
    if (typeof self._put === "function" && opts.new_edits !== false) {
      self._put(doc, opts, next);
    } else {
      self.bulkDocs({ docs: [doc] }, opts, yankError(next, doc._id));
    }
  }
});

AbstractPouchDB.prototype.remove = pouchdbUtils.adapterFun("remove", function(
  docOrId,
  optsOrRev,
  opts,
  callback
) {
  var doc;
  if (typeof optsOrRev === "string") {
    // id, rev, opts, callback style
    doc = {
      _id: docOrId,
      _rev: optsOrRev
    };
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
  } else {
    // doc, opts, callback style
    doc = docOrId;
    if (typeof optsOrRev === "function") {
      callback = optsOrRev;
      opts = {};
    } else {
      callback = opts;
      opts = optsOrRev;
    }
  }
  opts = opts || {};
  opts.was_delete = true;
  var newDoc = { _id: doc._id, _rev: doc._rev || opts.rev };
  newDoc._deleted = true;
  if (pouchdbMerge.isLocalId(newDoc._id) && typeof this._removeLocal === "function") {
    return this._removeLocal(doc, callback);
  }
  this.bulkDocs({ docs: [newDoc] }, opts, yankError(callback, newDoc._id));
});

AbstractPouchDB.prototype.revsDiff = pouchdbUtils.adapterFun("revsDiff", function(
  req,
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }
  var ids = Object.keys(req);

  if (!ids.length) {
    return callback(null, {});
  }

  var count = 0;
  var missing = new ExportedMap$$1();

  function addToMissing(id, revId) {
    if (!missing.has(id)) {
      missing.set(id, { missing: [] });
    }
    missing.get(id).missing.push(revId);
  }

  function processDoc(id, rev_tree) {
    // Is this fast enough? Maybe we should switch to a set simulated by a map
    var missingForId = req[id].slice(0);
    pouchdbMerge.traverseRevTree(rev_tree, function(isLeaf, pos, revHash, ctx, opts) {
      var rev = pos + "-" + revHash;
      var idx = missingForId.indexOf(rev);
      if (idx === -1) {
        return;
      }

      missingForId.splice(idx, 1);
      /* istanbul ignore if */
      if (opts.status !== "available") {
        addToMissing(id, rev);
      }
    });

    // Traversing the tree is synchronous, so now `missingForId` contains
    // revisions that were not found in the tree
    missingForId.forEach(function(rev) {
      addToMissing(id, rev);
    });
  }

  ids.map(function(id) {
    this._getRevisionTree(id, function(err, rev_tree) {
      if (err && err.status === 404 && err.message === "missing") {
        missing.set(id, { missing: req[id] });
      } else if (err) {
        /* istanbul ignore next */
        return callback(err);
      } else {
        processDoc(id, rev_tree);
      }

      if (++count === ids.length) {
        // convert LazyMap to object
        var missingObj = {};
        missing.forEach(function(value, key) {
          missingObj[key] = value;
        });
        return callback(null, missingObj);
      }
    });
  }, this);
});

// _bulk_get API for faster replication, as described in
// https://github.com/apache/couchdb-chttpd/pull/33
// At the "abstract" level, it will just run multiple get()s in
// parallel, because this isn't much of a performance cost
// for local databases (except the cost of multiple transactions, which is
// small). The http adapter overrides this in order
// to do a more efficient single HTTP request.
AbstractPouchDB.prototype.bulkGet = pouchdbUtils.adapterFun("bulkGet", function(
  opts,
  callback
) {
  pouchdbUtils.bulkGetShim(this, opts, callback);
});

// compact one document and fire callback
// by compacting we mean removing all revisions which
// are further from the leaf in revision tree than max_height
AbstractPouchDB.prototype.compactDocument = pouchdbUtils.adapterFun(
  "compactDocument",
  function(docId, maxHeight, callback) {
    var self = this;
    this._getRevisionTree(docId, function(err, revTree) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      var height = computeHeight(revTree);
      var candidates = [];
      var revs = [];
      Object.keys(height).forEach(function(rev) {
        if (height[rev] > maxHeight) {
          candidates.push(rev);
        }
      });

      pouchdbMerge.traverseRevTree(revTree, function(isLeaf, pos, revHash, ctx, opts) {
        var rev = pos + "-" + revHash;
        if (opts.status === "available" && candidates.indexOf(rev) !== -1) {
          revs.push(rev);
        }
      });
      self._doCompaction(docId, revs, callback);
    });
  }
);

// compact the whole database using single document
// compaction
AbstractPouchDB.prototype.compact = pouchdbUtils.adapterFun("compact", function(
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }

  var self = this;
  opts = opts || {};

  self._compactionQueue = self._compactionQueue || [];
  self._compactionQueue.push({ opts: opts, callback: callback });
  if (self._compactionQueue.length === 1) {
    doNextCompaction(self);
  }
});
AbstractPouchDB.prototype._compact = function(opts, callback) {
  var self = this;
  var changesOpts = {
    return_docs: false,
    last_seq: opts.last_seq || 0
  };
  var promises = [];

  function onChange(row) {
    promises.push(self.compactDocument(row.id, 0));
  }
  function onComplete(resp) {
    var lastSeq = resp.last_seq;
    Promise.all(promises)
      .then(function() {
        return pouchdbUtils.upsert(self, "_local/compaction", function deltaFunc(doc) {
          if (!doc.last_seq || doc.last_seq < lastSeq) {
            doc.last_seq = lastSeq;
            return doc;
          }
          return false; // somebody else got here first, don't update
        });
      })
      .then(function() {
        callback(null, { ok: true });
      })
      .catch(callback);
  }
  self
    .changes(changesOpts)
    .on("change", onChange)
    .on("complete", onComplete)
    .on("error", callback);
};

/* Begin api wrappers. Specific functionality to storage belongs in the
   _[method] */
AbstractPouchDB.prototype.get = pouchdbUtils.adapterFun("get", function(id, opts, cb) {
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  if (typeof id !== "string") {
    return cb(pouchdbErrors.createError(pouchdbErrors.INVALID_ID));
  }
  if (pouchdbMerge.isLocalId(id) && typeof this._getLocal === "function") {
    return this._getLocal(id, cb);
  }
  var leaves = [],
    self = this;

  function finishOpenRevs() {
    var result = [];
    var count = leaves.length;
    /* istanbul ignore if */
    if (!count) {
      return cb(null, result);
    }

    // order with open_revs is unspecified
    leaves.forEach(function(leaf) {
      self.get(
        id,
        {
          rev: leaf,
          revs: opts.revs,
          latest: opts.latest,
          binary: opts.binary
        },
        function(err, doc) {
          if (!err) {
            // using latest=true can produce duplicates
            var existing;
            for (var i = 0, l = result.length; i < l; i++) {
              if (result[i].ok && result[i].ok._rev === doc._rev) {
                existing = true;
                break;
              }
            }
            if (!existing) {
              result.push({ ok: doc });
            }
          } else {
            result.push({ missing: leaf });
          }
          count--;
          if (!count) {
            cb(null, result);
          }
        }
      );
    });
  }

  if (opts.open_revs) {
    if (opts.open_revs === "all") {
      this._getRevisionTree(id, function(err, rev_tree) {
        /* istanbul ignore if */
        if (err) {
          return cb(err);
        }
        leaves = pouchdbMerge.collectLeaves(rev_tree).map(function(leaf) {
          return leaf.rev;
        });
        finishOpenRevs();
      });
    } else {
      if (Array.isArray(opts.open_revs)) {
        leaves = opts.open_revs;
        for (var i = 0; i < leaves.length; i++) {
          var l = leaves[i];
          // looks like it's the only thing couchdb checks
          if (!(typeof l === "string" && /^\d+-/.test(l))) {
            return cb(pouchdbErrors.createError(pouchdbErrors.INVALID_REV));
          }
        }
        finishOpenRevs();
      } else {
        return cb(pouchdbErrors.createError(pouchdbErrors.UNKNOWN_ERROR, "function_clause"));
      }
    }
    return; // open_revs does not like other options
  }

  return this._get(id, opts, function(err, result) {
    if (err) {
      err.docId = id;
      return cb(err);
    }

    var doc = result.doc;
    var metadata = result.metadata;
    var ctx = result.ctx;

    if (opts.conflicts) {
      var conflicts = pouchdbMerge.collectConflicts(metadata);
      if (conflicts.length) {
        doc._conflicts = conflicts;
      }
    }

    if (pouchdbMerge.isDeleted(metadata, doc._rev)) {
      doc._deleted = true;
    }

    if (opts.revs || opts.revs_info) {
      var splittedRev = doc._rev.split("-");
      var revNo = parseInt(splittedRev[0], 10);
      var revHash = splittedRev[1];

      var paths = pouchdbMerge.rootToLeaf(metadata.rev_tree);
      var path = null;

      for (var i = 0; i < paths.length; i++) {
        var currentPath = paths[i];
        var hashIndex = currentPath.ids
          .map(function(x) {
            return x.id;
          })
          .indexOf(revHash);
        var hashFoundAtRevPos = hashIndex === revNo - 1;

        if (hashFoundAtRevPos || (!path && hashIndex !== -1)) {
          path = currentPath;
        }
      }

      /* istanbul ignore if */
      if (!path) {
        err = new Error("invalid rev tree");
        err.docId = id;
        return cb(err);
      }

      var indexOfRev =
        path.ids
          .map(function(x) {
            return x.id;
          })
          .indexOf(doc._rev.split("-")[1]) + 1;
      var howMany = path.ids.length - indexOfRev;
      path.ids.splice(indexOfRev, howMany);
      path.ids.reverse();

      if (opts.revs) {
        doc._revisions = {
          start: path.pos + path.ids.length - 1,
          ids: path.ids.map(function(rev) {
            return rev.id;
          })
        };
      }
      if (opts.revs_info) {
        var pos = path.pos + path.ids.length;
        doc._revs_info = path.ids.map(function(rev) {
          pos--;
          return {
            rev: pos + "-" + rev.id,
            status: rev.opts.status
          };
        });
      }
    }

    cb(null, doc);
  });
});

AbstractPouchDB.prototype.allDocs = pouchdbUtils.adapterFun("allDocs", function(
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }
  opts.skip = typeof opts.skip !== "undefined" ? opts.skip : 0;
  if (opts.start_key) {
    opts.startkey = opts.start_key;
  }
  if (opts.end_key) {
    opts.endkey = opts.end_key;
  }
  if ("keys" in opts) {
    if (!Array.isArray(opts.keys)) {
      return callback(new TypeError("options.keys must be an array"));
    }
    var incompatibleOpt = ["startkey", "endkey", "key"].filter(function(
      incompatibleOpt
    ) {
      return incompatibleOpt in opts;
    })[0];
    if (incompatibleOpt) {
      callback(
        pouchdbErrors.createError(
          pouchdbErrors.QUERY_PARSE_ERROR,
          "Query parameter `" +
            incompatibleOpt +
            "` is not compatible with multi-get"
        )
      );
      return;
    }
    //if (!isRemote(this)) {
    allDocsKeysParse(opts);
    if (opts.keys.length === 0) {
      return this._allDocs({ limit: 0 }, callback);
    }
    //}
  }

  return this._allDocs(opts, callback);
});

AbstractPouchDB.prototype.changes = function(opts, callback) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }

  opts = opts || {};

  // By default set return_docs to false if the caller has opts.live = true,
  // this will prevent us from collecting the set of changes indefinitely
  // resulting in growing memory
  opts.return_docs = "return_docs" in opts ? opts.return_docs : !opts.live;

  return new Changes(this, opts, callback);
};

AbstractPouchDB.prototype.close = pouchdbUtils.adapterFun("close", function(callback) {
  this._closed = true;
  this.emit("closed");
  return this._close(callback);
});

AbstractPouchDB.prototype.info = pouchdbUtils.adapterFun("info", function(callback) {
  var self = this;
  this._info(function(err, info) {
    if (err) {
      return callback(err);
    }
    // assume we know better than the adapter, unless it informs us
    info.db_name = info.db_name || self.name;
    info.auto_compaction = !!self.auto_compaction /* && !isRemote(self)*/;
    info.adapter = self.adapter;
    callback(null, info);
  });
});

AbstractPouchDB.prototype.id = pouchdbUtils.adapterFun("id", function(callback) {
  return this._id(callback);
});

/* istanbul ignore next */
AbstractPouchDB.prototype.type = function() {
  return typeof this._type === "function" ? this._type() : this.adapter;
};

AbstractPouchDB.prototype.bulkDocs = pouchdbUtils.adapterFun("bulkDocs", function(
  req,
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }

  opts = opts || {};

  if (Array.isArray(req)) {
    req = {
      docs: req
    };
  }

  if (!req || !req.docs || !Array.isArray(req.docs)) {
    return callback(pouchdbErrors.createError(pouchdbErrors.MISSING_BULK_DOCS));
  }

  for (var i = 0; i < req.docs.length; ++i) {
    if (typeof req.docs[i] !== "object" || Array.isArray(req.docs[i])) {
      return callback(pouchdbErrors.createError(pouchdbErrors.NOT_AN_OBJECT));
    }
  }

  if (!("new_edits" in opts)) {
    if ("new_edits" in req) {
      opts.new_edits = req.new_edits;
    } else {
      opts.new_edits = true;
    }
  }
  if (!opts.new_edits /* && !isRemote(adapter)*/) {
    // ensure revisions of the same doc are sorted, so that
    // the local adapter processes them correctly (#2935)
    req.docs.sort(compareByIdThenRev);
  }

  cleanDocs(req.docs);

  // in the case of conflicts, we want to return the _ids to the user
  // however, the underlying adapter may destroy the docs array, so
  // create a copy here
  var ids = req.docs.map(function(doc) {
    return doc._id;
  });

  return this._bulkDocs(req, opts, function(err, res) {
    if (err) {
      return callback(err);
    }
    if (!opts.new_edits) {
      // this is what couch does when new_edits is false
      res = res.filter(function(x) {
        return x.error;
      });
    }
    // add ids for error/conflict responses (not required for CouchDB)
    //if (!isRemote(adapter)) {
    for (var i = 0, l = res.length; i < l; i++) {
      res[i].id = res[i].id || ids[i];
    }
    //}

    callback(null, res);
  });
});

AbstractPouchDB.prototype.registerDependentDatabase = pouchdbUtils.adapterFun(
  "registerDependentDatabase",
  function(dependentDb, callback) {
    var depDB = new this.constructor(dependentDb, this.__opts);

    function diffFun(doc) {
      doc.dependentDbs = doc.dependentDbs || {};
      if (doc.dependentDbs[dependentDb]) {
        return false; // no update required
      }
      doc.dependentDbs[dependentDb] = true;
      return doc;
    }
    pouchdbUtils.upsert(this, "_local/_pouch_dependentDbs", diffFun)
      .then(function() {
        callback(null, { db: depDB });
      })
      .catch(callback);
  }
);

AbstractPouchDB.prototype.destroy = pouchdbUtils.adapterFun("destroy", function(
  opts,
  callback
) {
  if (typeof opts === "function") {
    callback = opts;
    opts = {};
  }

  var self = this;
  var usePrefix = "use_prefix" in self ? self.use_prefix : true;

  function destroyDb() {
    // call destroy method of the particular adaptor
    self._destroy(opts, function(err, resp) {
      if (err) {
        return callback(err);
      }
      self._destroyed = true;
      self.emit("destroyed");
      callback(null, resp || { ok: true });
    });
  }

  // if (isRemote(self)) {
  //   // no need to check for dependent DBs if it's a remote DB
  //   return destroyDb();
  // }

  self.get("_local/_pouch_dependentDbs", function(err, localDoc) {
    if (err) {
      /* istanbul ignore if */
      if (err.status !== 404) {
        return callback(err);
      } else {
        // no dependencies
        return destroyDb();
      }
    }
    var dependentDbs = localDoc.dependentDbs;
    var PouchDB = self.constructor;
    var deletedMap = Object.keys(dependentDbs).map(function(name) {
      // use_prefix is only false in the browser
      /* istanbul ignore next */
      var trueName = usePrefix
        ? name.replace(new RegExp("^" + PouchDB.prefix), "")
        : name;
      return new PouchDB(trueName, self.__opts).destroy();
    });
    Promise.all(deletedMap).then(destroyDb, callback);
  });
});

function TaskQueue() {
  this.isReady = false;
  this.failed = false;
  this.queue = [];
}

TaskQueue.prototype.execute = function () {
  var fun;
  if (this.failed) {
    while ((fun = this.queue.shift())) {
      fun(this.failed);
    }
  } else {
    while ((fun = this.queue.shift())) {
      fun();
    }
  }
};

TaskQueue.prototype.fail = function (err) {
  this.failed = err;
  this.execute();
};

TaskQueue.prototype.ready = function (db) {
  this.isReady = true;
  this.db = db;
  this.execute();
};

TaskQueue.prototype.addTask = function (fun) {
  this.queue.push(fun);
  if (this.failed) {
    this.execute();
  }
};

// import { guardedConsole /*, hasLocalStorage */ } from 'pouchdb-utils';

function parseAdapter(name, opts) {
  var match = name.match(/([a-z-]*):\/\/(.*)/);
  if (match) {
    // the http adapter expects the fully qualified name
    return {
      name: /https?/.test(match[1]) ? match[1] + '://' + match[2] : match[2],
      adapter: match[1]
    };
  }

  var adapters = PouchDB.adapters;
  var preferredAdapters = PouchDB.preferredAdapters;
  var prefix = PouchDB.prefix;
  var adapterName = opts.adapter;

  if (!adapterName) { // automatically determine adapter
    for (var i = 0; i < preferredAdapters.length; ++i) {
      adapterName = preferredAdapters[i];
      // check for browsers that have been upgraded from websql-only to websql+idb
      /* istanbul ignore if */
      if (adapterName === 'idb' && 'websql' in adapters &&
          /* hasLocalStorage() && */ localStorage['_pouch__websqldb_' + prefix + name]) {
        // log it, because this can be confusing during development
        guardedConsole('log', 'PouchDB is downgrading "' + name + '" to WebSQL to' +
          ' avoid data loss, because it was already opened with WebSQL.');
        continue; // keep using websql to avoid user data loss
      }
      break;
    }
  }


  // var adapter = adapters["leveldb"];
  var adapter = adapters[adapterName];

  // if adapter is invalid, then an error will be thrown later
  var usePrefix = (adapter && 'use_prefix' in adapter) ?
    adapter.use_prefix : true;

  return {
    name: usePrefix ? (prefix + name) : name,
    adapter: adapterName
  };
}

// OK, so here's the deal. Consider this code:
//     var db1 = new PouchDB('foo');
//     var db2 = new PouchDB('foo');
//     db1.destroy();
// ^ these two both need to emit 'destroyed' events,
// as well as the PouchDB constructor itself.
// So we have one db object (whichever one got destroy() called on it)
// responsible for emitting the initial event, which then gets emitted
// by the constructor, which then broadcasts it to any other dbs
// that may have been created with the same name.
function prepareForDestruction(self) {

  function onDestroyed(from_constructor) {
    self.removeListener('closed', onClosed);
    if (!from_constructor) {
      self.constructor.emit('destroyed', self.name);
    }
  }

  function onClosed() {
    self.removeListener('destroyed', onDestroyed);
    self.constructor.emit('unref', self);
  }

  self.once('destroyed', onDestroyed);
  self.once('closed', onClosed);
  self.constructor.emit('ref', self);
}

inherits(PouchDB, AbstractPouchDB);
function PouchDB(name, opts) {
  // In Node our test suite only tests this for PouchAlt unfortunately
  /* istanbul ignore if */
  if (!(this instanceof PouchDB)) {
    return new PouchDB(name, opts);
  }

  var self = this;
  opts = opts || {};

  if (name && typeof name === 'object') {
    opts = name;
    name = opts.name;
    delete opts.name;
  }

  if (opts.deterministic_revs === undefined) {
    opts.deterministic_revs = true;
  }

  this.__opts = opts = pouchdbUtils.clone(opts);

  self.auto_compaction = opts.auto_compaction;
  self.prefix = PouchDB.prefix;

  if (typeof name !== 'string') {
    throw new Error('Missing/invalid DB name');
  }

  var prefixedName = (opts.prefix || '') + name;
  var backend = parseAdapter(prefixedName, opts);

  opts.name = backend.name;
  opts.adapter = opts.adapter || backend.adapter;

  self.name = name;
  self._adapter = opts.adapter;
  PouchDB.emit('debug', ['adapter', 'Picked adapter: ', opts.adapter]);

  if (!PouchDB.adapters[opts.adapter] ||
      !PouchDB.adapters[opts.adapter].valid()) {
    throw new Error('Invalid Adapter: ' + opts.adapter);
  }

  AbstractPouchDB.call(self);
  self.taskqueue = new TaskQueue();

  self.adapter = opts.adapter;

  PouchDB.adapters[opts.adapter].call(self, opts, function (err) {
    if (err) {
      return self.taskqueue.fail(err);
    }
    prepareForDestruction(self);

    self.emit('created', self);
    PouchDB.emit('created', self.name);
    self.taskqueue.ready(self);
  });

}

PouchDB.adapters = {};
PouchDB.preferredAdapters = [];

PouchDB.prefix = '_pouch_';

var eventEmitter = new events.EventEmitter();

function setUpEventEmitter(Pouch) {
  Object.keys(events.EventEmitter.prototype).forEach(function (key) {
    if (typeof events.EventEmitter.prototype[key] === 'function') {
      Pouch[key] = eventEmitter[key].bind(eventEmitter);
    }
  });

  // these are created in constructor.js, and allow us to notify each DB with
  // the same name that it was destroyed, via the constructor object
  var destructListeners = Pouch._destructionListeners = new ExportedMap$$1();

  Pouch.on('ref', function onConstructorRef(db) {
    if (!destructListeners.has(db.name)) {
      destructListeners.set(db.name, []);
    }
    destructListeners.get(db.name).push(db);
  });

  Pouch.on('unref', function onConstructorUnref(db) {
    if (!destructListeners.has(db.name)) {
      return;
    }
    var dbList = destructListeners.get(db.name);
    var pos = dbList.indexOf(db);
    if (pos < 0) {
      /* istanbul ignore next */
      return;
    }
    dbList.splice(pos, 1);
    if (dbList.length > 1) {
      /* istanbul ignore next */
      destructListeners.set(db.name, dbList);
    } else {
      destructListeners.delete(db.name);
    }
  });

  Pouch.on('destroyed', function onConstructorDestroyed(name) {
    if (!destructListeners.has(name)) {
      return;
    }
    var dbList = destructListeners.get(name);
    destructListeners.delete(name);
    dbList.forEach(function (db) {
      db.emit('destroyed',true);
    });
  });
}

setUpEventEmitter(PouchDB);

PouchDB.adapter = function (id, obj, addToPreferredAdapters) {
  /* istanbul ignore else */
  if (obj.valid()) {
    PouchDB.adapters[id] = obj;
    if (addToPreferredAdapters) {
      PouchDB.preferredAdapters.push(id);
    }
  }
};

PouchDB.plugin = function (obj) {
  if (typeof obj === 'function') { // function style for plugins
    obj(PouchDB);
  } else if (typeof obj !== 'object' || Object.keys(obj).length === 0) {
    throw new Error('Invalid plugin: got "' + obj + '", expected an object or a function');
  } else {
    Object.keys(obj).forEach(function (id) { // object style for plugins
      PouchDB.prototype[id] = obj[id];
    });
  }
  if (this.__defaults) {
    PouchDB.__defaults = pouchdbUtils.assign({}, this.__defaults);
  }
  return PouchDB;
};

PouchDB.defaults = function (defaultOpts) {
  function PouchAlt(name, opts) {
    if (!(this instanceof PouchAlt)) {
      return new PouchAlt(name, opts);
    }

    opts = opts || {};

    if (name && typeof name === 'object') {
      opts = name;
      name = opts.name;
      delete opts.name;
    }

    opts = pouchdbUtils.assign({}, PouchAlt.__defaults, opts);
    PouchDB.call(this, name, opts);
  }

  inherits(PouchAlt, PouchDB);

  PouchAlt.preferredAdapters = PouchDB.preferredAdapters.slice();
  Object.keys(PouchDB).forEach(function (key) {
    if (!(key in PouchAlt)) {
      PouchAlt[key] = PouchDB[key];
    }
  });

  // make default options transitive
  // https://github.com/pouchdb/pouchdb/issues/5922
  PouchAlt.__defaults = pouchdbUtils.assign({}, this.__defaults, defaultOpts);

  return PouchAlt;
};

// managed automatically by set-version.js
var version = "7.0.0-prerelease";

PouchDB.version = version;

module.exports = PouchDB;
