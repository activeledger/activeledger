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
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { ActiveHttpd } from "./httpd";
import PouchDB from "./pouchdb";

(function() {
  // Fauxton Path
  const FAUXTON_PATH = path.dirname(require.resolve("pouchdb-fauxton"));

  // PouchDB Connection Handler
  const PouchDb = PouchDB.defaults({ prefix: "./" + process.argv[2] + "/" });

  // Create Light Server
  let http = new ActiveHttpd();

  // Index
  http.use("/", () => {
    return {
      activeledger: "Welcome to Activeledger data!",
      adapters: ["leveldb"]
    };
  });

  // Standard Session
  http.use("_session", () => {
    return { ok: true, userCtx: { name: null, roles: ["_admin"] } };
  });

  // List all databases
  http.use("_all_dbs", async () => {
    // Get Database
    let db = new PouchDb("pouch__all_dbs__");

    // Search for other databases
    let x = await db.allDocs({
      startkey: "db_",
      endkey: "db_" + "\uffff"
    });

    // Correct output
    return x.rows.map((e: any) => e.id.replace("db_", ""));
  });

  // Get Nested stuff
  http.use("*/*/hello", () => {
    return "it works";
  });

  // Fauxton
  http.use("_utils", (req: http.IncomingMessage, res: http.ServerResponse) => {
    // We want to force /_utils to /_utils/ as this is the CouchDB behavior
    if (req.url === "/_utils") {
      res.writeHead(301, {
        Location: "/_utils/"
      });
      return;
    }

    // File to send
    let file = FAUXTON_PATH + "/index.html";

    // If path is not default overwrite
    if (req.url !== "/_utils/") {
      file = FAUXTON_PATH + (req.url as string).replace("/_utils", "");
    }

    if (fs.existsSync(file)) {
      res.setHeader(
        "Content-type",
        ActiveHttpd.mimeType[path.parse(file).ext] || "text/plain"
      );
      // Convert To Stream
      return fs.readFileSync(file);
    }
  });

  // Start Server
  http.listen(parseInt(process.argv[3]));
})();
