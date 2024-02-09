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
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { CLIHandler } from "./cli/cli";

// Set during build
const version = "unset";

// Initalise CLI Options
ActiveOptions.init();

// Do we have an identity (Will always need, Can be shared)
if (!fs.existsSync("./.identity")) {
  ActiveLogger.info("No Identity found. Generating Identity");
  let identity: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair();
  fs.writeFileSync("./.identity", JSON.stringify(identity.generate()));
  ActiveLogger.info("Identity Generated. Continue Boot Cycle");
}

// Quick Testnet builder
if (ActiveOptions.get<boolean>("testnet", false)) {
  CLIHandler.setupTestnet();
} else if (ActiveOptions.get<boolean>("merge", false)) {
  // Merge Configs (Helps Build local net)
  CLIHandler.merge();
} else if (ActiveOptions.get<boolean>("stop", false)) {
  CLIHandler.stop();
} else if (ActiveOptions.get<boolean>("restart", false)) {
  if (ActiveOptions.get<boolean>("auto", false)) {
    CLIHandler.restart(true);
  } else {
    CLIHandler.restart();
  }
} else if (ActiveOptions.get<boolean>("stats", false)) {
  CLIHandler.getStats(version);
} else if (ActiveOptions.get<boolean>("compact", false)) {
  CLIHandler.startCompact();
} else if (ActiveOptions.get<boolean>("flush", false)) {
  CLIHandler.flushArchives(ActiveOptions.get<number>("flush", false));
} else if (
  ActiveOptions.get<boolean>("version", false) ||
  ActiveOptions.get<boolean>("v", false)
) {
  CLIHandler.getVersion();
} else {
  CLIHandler.start();
}

process.on("SIGTERM", async () => {
  process.exit();
});
