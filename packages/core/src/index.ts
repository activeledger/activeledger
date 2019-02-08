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

import { ActivecoreApplication } from "./application";
import { ApplicationConfig } from "@loopback/core";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * Loopback Main Launcher
 *
 * @param {ApplicationConfig} [options={}]
 * @returns
 */
async function main(options: ApplicationConfig = {}) {
  const app = new ActivecoreApplication(options);
  await app.boot();
  await app.start();

  const url = app.restServer.url;
  ActiveLogger.info(`Server is running at ${url}`);

  return app;
}

// Initalise CLI Options
ActiveOptions.init();

// Parse Config
ActiveOptions.parseConfig();

// Basic check for database and config
if (ActiveOptions.get("db", false)) {
  // Extend Config
  ActiveOptions.extendConfig();

  // Start The Application
  main({
    rest: {
      port: ActiveOptions.get<any>("api", {}).port || 5261
    }
  }).catch(error => {
    ActiveLogger.fatal(error, "Cannot start Activecore API");
    process.exit(1);
  });
} else {
  ActiveLogger.fatal("Configuration file incomplete");
  process.exit(0);
}
