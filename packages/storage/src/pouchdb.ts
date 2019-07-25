/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import module from "module";

// Copy default require
let _require = module.prototype.require;

// Overwrite require for correct local paths
module.prototype.require = function() {
  if (arguments[0].indexOf("pouchdb") !== -1) {
    arguments[0] = __dirname + "/pouchdb/" + arguments[0];
  }
  return _require.apply(this, arguments);
};

// Import Local PouchDB
const PouchDB: any = require("pouchdb-core");
const PouchDBLdB: any = require("pouchdb-adapter-leveldb");
const PouchDBFind: any = require("pouchdb-find");

// Restore Require
module.prototype.require = _require;

// Export LevelDB Sub Modules
const PouchRequire = require.cache[require.resolve(__dirname + "/pouchdb/" + "pouchdb-adapter-leveldb")];
const leveldown: any = PouchRequire.require("leveldown");
// Add Plugins
PouchDB.plugin(PouchDBLdB).plugin(PouchDBFind);
export { PouchDB, leveldown };
