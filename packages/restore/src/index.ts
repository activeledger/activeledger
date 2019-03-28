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

import { ActiveOptions } from "@activeledger/activeoptions";
import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
class ActiveRestore {
  private configName = "config.json";

  constructor() {
    ActiveOptions.init();
  }

  private getConfig(): void {
    let path = ActiveOptions.get<string>("path", "");
    let config = ActiveOptions.get<string>("config", this.configName);

    if (path) {
      ActiveOptions.set("config", path + config);
    }

    if (!fs.existsSync(config)) {
      throw ActiveLogger.fatal(`No config file found (${config})`);
    }

    ActiveOptions.parseConfig();
  }

  private getIdentity(): void {
    const identity = ActiveOptions.get<string | boolean>("identity", false);
    const path = ActiveOptions.get<string>("path", ".") + "/.identity";
    if (identity) {
      ActiveOptions.set("identity", path);
    }

    if (!fs.existsSync(path)) {
      throw ActiveLogger.fatal(`No Identity file found (${path})`);
    }
  }

  private extendConfig(): void {}

  // private
}
