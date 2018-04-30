#!/usr/bin/env node

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

import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";
import * as ChildP from "child_process";
import * as minimist from "minimist";
import { ActiveNetwork, ActiveInterfaces } from "@activeledger/activenetwork";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";

// Process Arguments
// TOOD: Change solution to static class
(global as any).argv = minimist(process.argv.slice(2));

// Check for config
if (!fs.existsSync((global as any).argv.config || "./config.json"))
  throw ActiveLogger.fatal(
    "No Config File Found (" + (global as any).argv.config ||
      "./config.json" + ")"
  );

// Get Config & Set as Global
// TOOD: Change solution to static class
(global as any).config = JSON.parse(
  fs.readFileSync((global as any).argv.config || "./config.json", "utf8")
);

// Manage Node Cluster
if (cluster.isMaster) {
  // Do we have an identity
  if (!fs.existsSync("./.identity")) {
    ActiveLogger.info("No Identity found. Generating Identity");
    let identity: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair();
    fs.writeFileSync("./.identity", JSON.stringify(identity.generate()));
    ActiveLogger.info("Identity Generated. Continue Boot Cycle");
  }

  // Self hosted data storage engine
  if ((global as any).config.db.selfhost) {
    // Folder Location
    let dblocation = (global as any).config.db.selfhost.dir || "./.ds";

    // Check folder exists
    if (!fs.existsSync(dblocation)) {
      fs.mkdirSync(dblocation);
    }

    // Start Server, Can't block as server wont return
    ActiveLogger.info(
      "Self-hosted data engine @ http://localhost:" +
        (global as any).config.db.selfhost.port
    );

    // Launch Background Database Process
    let pDB: ChildP.ChildProcess = ChildP.spawn(
      "node",
      [
        "./lib/selfdb.js",
        `${dblocation || ".ds"}`,
        `${(global as any).config.db.selfhost.port}`
      ],
      {
        cwd: "./"
      }
    );

    pDB.on("exit", () => {
      ActiveLogger.info("PouchDown");
      pDB.kill("SIGINT");
      // Wait 10 seconds and bring back up
      setTimeout(() => {
        let pDB: ChildP.ChildProcess = ChildP.spawn(
          "node",
          [
            "./lib/selfdb.js",
            `${dblocation || ".ds"}`,
            `${(global as any).config.db.selfhost.port}`
          ],
          {
            cwd: "./"
          }
        );
      }, 10000);
    });

    ActiveLogger.info(`Self-hosted data engine : Starting Up (${pDB.pid})`);

    // Write process id for restore engine to manage
    fs.writeFileSync(dblocation + "/.pid", pDB.pid);

    // Rewrite config for this process
    (global as any).config.db.url =
      "http://127.0.0.1:" + (global as any).config.db.selfhost.port;
  }

  // Launch as many nodes as cpus
  let cpus = os.cpus().length;
  ActiveLogger.info("Server is active, Creating forks " + cpus);

  // Create Master Home
  let activeHome: ActiveNetwork.Home = new ActiveNetwork.Home();

  // Manage Activeledger Process Sessions
  let activeSession: ActiveNetwork.Session = new ActiveNetwork.Session(
    activeHome
  );

  // Maintain Network Neighbourhood & Let Workers know
  let activeWatch = new ActiveNetwork.Maintain(activeHome, activeSession);

  // Loop CPUs and fork
  while (cpus--) {
    activeSession.add(cluster.fork());
  }

  // Watch for worker exit / crash and restart
  cluster.on("exit", worker => {
    ActiveLogger.debug(worker, "Worker has died, Restarting");
    let restart = activeSession.add(cluster.fork());
    // We can restart but we need to update the workers left & right & ishome
    //worker.send({type:"neighbour",})
  });
} else {
  // Temporary Path Solution
  (global as any).__base = __dirname;

  // Self hosted data storage engine
  if ((global as any).config.db.selfhost) {
    // Rewrite config for this process
    (global as any).config.db.url =
      "http://localhost:" + (global as any).config.db.selfhost.port;
  }

  // Create Home Host Node
  let activeHost = new ActiveNetwork.Host();
}
