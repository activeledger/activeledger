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

  // Get base version of Express
  let app: any = require("express")();

  // Basic middleware needed to reroute incorrect paths
  app.use((req: any, res: any, next: any) => {
    // Fix double forward slash problem
    req.originalUrl = req.originalUrl.replace("//", "/");
    next();
  });

  // Get PouchDB (With Correct Path) Specific Express
  app.use(
    "/",
    require("express-pouchdb")(
      PouchDB.defaults({ prefix: "./" + process.argv[2] + "/" })
    )
  );

  // Start
  app.listen(process.argv[3]);
})();
