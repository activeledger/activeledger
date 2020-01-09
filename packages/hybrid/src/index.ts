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

 import * as fs from "fs";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDataStore } from "@activeledger/activestorage";
import { IUpstreamNode } from "./interfaces/hybrid.interface";
import { HybridNode } from "./server";

// WARNING: Lots of copy pasted code here in functional way, Get working then improve!

/*
IOT Options

1. Core as is, Use PRoxy auth
2. Core --iot mode which expects a code known to both server and client
    this code could be per idenitty or a --iot owjefiowfjweiof flag and httpS secure this!
    /stream/code/and / or hash of public?
3. Node, HAs an SSe endpoint that takes stream ids with the same public key and a random code signed.

 NOT FOR NOW : With IoT and core no auth, I wonder if the solution
 is they sign a code with their key to get the SSE connection accepted?
 doing this means we could also send in real-time from a mainnet node
 However for now best to keep in here less overhead and less chance of vunrabilities
*/

// Initalise CLI Options
ActiveOptions.init();

//#region Check & Manage Configuration File
if (!fs.existsSync(ActiveOptions.get<string>("config", "./config.json"))) {
  // Read default config so we can add our identity to the neighbourhood
  let defConfig: any = JSON.parse(
    fs.readFileSync(__dirname + "/default.config.json", "utf8")
  );

  // Adjusting Ports (Check for default port)
  if (
    ActiveOptions.get<boolean>("port", false) &&
    ActiveOptions.get<number>("port", 5260) !== 5260
  ) {
    // Update Node Host
    defConfig.host =
      ActiveOptions.get<string>("host", "127.0.0.1") +
      ":" +
      ActiveOptions.get<string>("port", 5260);

    // Update Self host
    defConfig.db.selfhost.port = (
      parseInt(ActiveOptions.get<string>("port", 5260)) - 1
    ).toString();
  }

  // Data directory passed?
  if (ActiveOptions.get<boolean>("data-dir", false)) {
    defConfig.db.selfhost.dir = ActiveOptions.get<string>("data-dir", "");
  }

  // lets write the default one in this location
  fs.writeFileSync(
    ActiveOptions.get<string>("config", "./config.json"),
    JSON.stringify(defConfig)
  );
  ActiveLogger.info("Created Hybrid Config File");
}
//#endregion
ActiveOptions.parseConfig();

// Set Base Path
ActiveOptions.set("__base", __dirname);

// Check for local contracts folder
if (!fs.existsSync("contracts")) fs.mkdirSync("contracts");

// Check for modules link for running contracts
if (!fs.existsSync("contracts/node_modules"))
  fs.symlinkSync(
    `${__dirname}/../node_modules`,
    "contracts/node_modules",
    "dir"
  );

// Basic check for database and config
if (ActiveOptions.get("db", false)) {
  // Self Hosted Database
  if (ActiveOptions.get<any>("db", {}).selfhost) {
    // Create Datastore instance
    let datastore: ActiveDataStore = new ActiveDataStore();

    // Rewrite config for this process
    ActiveOptions.get<any>("db", {}).url = datastore.launch();

    // Enable Extended Debugging
    ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

    // Wait a bit for process to fully start
    setTimeout(() => {
      boot();
    }, 2000);
  }
} else {
  ActiveLogger.fatal("Configuration file incomplete");
  process.exit(0);
}

/**
 * Start Hybrid Application
 *
 */
function boot() {
  // Upstream Details
  const upstreamNode = ActiveOptions.get<IUpstreamNode>("upstream", {});
  if (!upstreamNode.remote && !upstreamNode.port && !upstreamNode.auth) {
    ActiveLogger.fatal("No Upstream Node Configured");
    process.exit(0);
  }

  const hybrid = new HybridNode(upstreamNode);
  hybrid.start();
}
