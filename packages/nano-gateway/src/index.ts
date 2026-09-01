#!/usr/bin/env node

/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
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

/*
 * packages/hybrid/src/index.ts (this repo) carries a prior developer's own
 * design note asking almost this exact question: "With IoT and core no
 * auth, I wonder if the solution is they sign a code with their key to
 * get the SSE connection accepted?" - concluded "NOT FOR NOW" at the time.
 * This package is that idea, built for nano clients specifically. See
 * ./auth.ts.
 */

import * as fs from "fs";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { NanoGatewayServer } from "./server";

ActiveOptions.init();

const configPath = ActiveOptions.get<string>("config", "./config.json");
if (!fs.existsSync(configPath)) {
  const defaultConfig = fs.readFileSync(__dirname + "/default.config.json", "utf8");
  fs.writeFileSync(configPath, defaultConfig);
  ActiveLogger.info(`Created nano-gateway config file at ${configPath}`);
}
ActiveOptions.parseConfig();

if (!ActiveOptions.get("db", false)) {
  ActiveLogger.fatal("Configuration file incomplete - no db connection configured");
  process.exit(1);
}

const gatewayConfig = ActiveOptions.get<{ allowlist: string }>("nanoGateway", { allowlist: "./nano-allowlist.json" });
if (!fs.existsSync(gatewayConfig.allowlist)) {
  fs.writeFileSync(gatewayConfig.allowlist, "[]\n");
  ActiveLogger.info(`Created empty allowlist at ${gatewayConfig.allowlist} - no nanos can connect until you add identities to it`);
}

ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

const server = new NanoGatewayServer();
server.start(ActiveOptions.get<boolean>("debug", false));
