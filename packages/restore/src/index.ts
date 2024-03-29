#!/usr/bin/env node

/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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

import { Helper } from "./modules/helper/helper";
import { Provider } from "./modules/provider/provider";
import { Interagent } from "./modules/interagent/interagent";
import { QuickRestore } from "./modules/quick-restore/quick-restore";

class ActiveRestore {
  private verbose = false;

  constructor() {
    Helper.verbose = this.verbose;

    this.initialise();
  }

  private async initialise(): Promise<void> {
    const normalRestore = () => {
      new Interagent();
      // Error Watcher
      // Provider.errorFeed.start();
      // Archive Watcher
      // Provider.archiveFeed.start();
    };

    await Provider.initialise();
    !Provider.isQuickFullRestore ? normalRestore() : new QuickRestore();
  }
}

new ActiveRestore();
