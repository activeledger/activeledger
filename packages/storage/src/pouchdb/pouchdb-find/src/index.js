import { toPromise /*, isRemote*/ } from "pouchdb-utils";
import * as local from "./adapters/local/index";

var plugin = {};
plugin.createIndex = toPromise(function(requestDef, callback) {
  if (typeof requestDef !== "object") {
    return callback(new Error("you must provide an index to create"));
  }

  local.createIndex(this, requestDef, callback);
});

plugin.find = toPromise(function(requestDef, callback) {
  if (typeof callback === "undefined") {
    callback = requestDef;
    requestDef = undefined;
  }

  if (typeof requestDef !== "object") {
    return callback(new Error("you must provide search parameters to find()"));
  }

  local.find(this, requestDef, callback);
});

plugin.explain = toPromise(function(requestDef, callback) {
  if (typeof callback === "undefined") {
    callback = requestDef;
    requestDef = undefined;
  }

  if (typeof requestDef !== "object") {
    return callback(
      new Error("you must provide search parameters to explain()")
    );
  }

  local.explain(this, requestDef, callback);
});

plugin.getIndexes = toPromise(function(callback) {
  local.getIndexes(this, callback);
});

plugin.deleteIndex = toPromise(function(indexDef, callback) {
  if (typeof indexDef !== "object") {
    return callback(new Error("you must provide an index to delete"));
  }

  local.deleteIndex(this, indexDef, callback);
});

export default plugin;
