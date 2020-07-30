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
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveHttpd } from "@activeledger/httpd";
import { findUmid } from "./controllers/umid";
import { options, openApi, explorer, welcome } from "./controllers/general";
import {
  contractSpecificEvent,
  contractEvents,
  events
} from "./controllers/events";
import {
  allActivityStreams,
  specificActivityStream,
  multipleActivityStreams
} from "./controllers/subscriptions";
// import { search } from "./controllers/query";
import { encrypt, decrypt } from "./controllers/encryption";
import {
  changes,
  getVolatile,
  setVolatile,
  getStream,
  getStreams
} from "./controllers/streams";

// Initalise CLI Options
ActiveOptions.init();

// Parse Config
ActiveOptions.parseConfig();

// Basic check for database and config
if (ActiveOptions.get("db", false)) {
  // Extend Config
  ActiveOptions.extendConfig();
  // Create Light Server
  let http = new ActiveHttpd(true);

  // Welcome
  http.use("/", "GET", welcome);

  // Misc
  http.use("/explorer", "GET", explorer);
  http.use("/openapi.json", "GET", openApi);
  http.use("**", "OPTIONS", options);

  // Activity
  http.use("/api/activity/subscribe/*", "GET", specificActivityStream);
  http.use("/api/activity/subscribe/**", "GET", multipleActivityStreams);
  http.use("/api/activity/subscribe", "GET", allActivityStreams);
  http.use("/api/activity/subscribe", "POST", multipleActivityStreams);

  // Events
  http.use("/api/events/*/*", "GET", contractSpecificEvent);
  http.use("/api/events/*", "GET", contractEvents);
  http.use("/api/events", "GET", events);

  // Encryption
  http.use("/api/secured/encrypt", "POST", encrypt);
  http.use("/api/secured/decrypt", "POST", decrypt);

  // Query Activeledger ⚠️Deprecated⚠️
  // http.use("/api/stream/search", "POST", search);
  // http.use("/api/stream/search", "GET", search);

  // Streams
  http.use("/api/stream/changes", "GET", changes);
  http.use("/api/stream/*/volatile", "GET", getVolatile);
  http.use("/api/stream/*/volatile", "POST", setVolatile);
  http.use("/api/stream/*", "GET", getStream);
  http.use("/api/stream", "POST", getStreams);

  // transaction
  http.use("/api/tx/*", "GET", findUmid);

  // Listen!
  const port = ActiveOptions.get<any>("api", {}).port || 5261;
  http.listen(port);
  ActiveLogger.info("Activecore API is running at 0.0.0.0:" + port);
} else {
  ActiveLogger.fatal("Configuration file incomplete");
  process.exit(0);
}
