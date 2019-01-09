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
(function() {
  // Get Local PouchDB 7
  let PouchDB: any = require("pouchdb");

  // Create PouchDB's express app
  var app = require("express-pouchdb")({
    mode: "minimumForPouchDB",
    inMemoryConfig: true,
    overrideMode: {
      include: [
        "config-infrastructure",
        "routes/fauxton",
        "routes/find",
        "routes/replicate",
        "routes/uuids"
      ],
      exclude: ["routes/attachments", "routes/compact", "routes/temp-views"]
    }
  });

  // Attach Pouch Connection
  app.setPouchDB(PouchDB.defaults({ prefix: "./" + process.argv[2] + "/" }));

  // Start
  app.listen(process.argv[3]);
})();
