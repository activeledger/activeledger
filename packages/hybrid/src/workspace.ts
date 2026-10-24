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
import * as path from "path";

/**
 * The directories Process runs contracts from, set up the way a supernode
 * does at start-up: `contracts/` for deployed contracts and
 * `default_contracts/` for the built-in ones, each with a `node_modules`
 * link so a contract's `require("@activeledger/activecontracts")` resolves.
 */

/** The node_modules directory that holds `pkg`, searched from here */
export function resolveModulesDir(pkg = "@activeledger/activecontracts"): string {
  const searched = require.resolve.paths(pkg) || [];
  for (const dir of searched) {
    if (fs.existsSync(path.join(dir, pkg))) return fs.realpathSync(dir);
  }
  throw new Error(
    `Could not find a node_modules containing ${pkg} (searched ${searched.length} locations): contracts would have nothing to require`
  );
}

/** The directory the supernode's compiled default contracts live in */
export function resolveDefaultContracts(): string {
  const pkg = "@activeledger/activeledger";
  const searched = require.resolve.paths(pkg) || [];
  for (const dir of searched) {
    const candidate = path.join(dir, pkg, "lib", "contracts", "default");
    if (fs.existsSync(path.join(candidate, "contract.js"))) return fs.realpathSync(candidate);
  }
  throw new Error(`Could not find the default contracts of ${pkg}`);
}

const linkModules = (dir: string, modules: string) => {
  const link = path.join(dir, "node_modules");
  if (!fs.existsSync(link)) fs.symlinkSync(modules, link, "dir");
};

/**
 * Create `contracts/` and `default_contracts/` under `cwd`. Default contracts
 * are copied afresh each time, so an upgraded hybrid runs the upgraded ones.
 */
export function prepareWorkspace(cwd: string = process.cwd()): void {
  const modules = resolveModulesDir();
  const defaults = resolveDefaultContracts();

  const contracts = path.join(cwd, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  linkModules(contracts, modules);

  const target = path.join(cwd, "default_contracts");
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(defaults)) {
    if (file.endsWith(".js")) fs.copyFileSync(path.join(defaults, file), path.join(target, file));
  }
  linkModules(target, modules);
}
