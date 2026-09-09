#!/usr/bin/env node
/**
 * Sets one version across the whole workspace.
 *
 * Replaces `lerna version --exact --force-publish`. Three things have to
 * move together or a release is inconsistent:
 *
 *   1. the root package.json version, which is the single source of truth
 *      now that lerna.json is gone;
 *   2. every packages/-/package.json version;
 *   3. every dependency range INSIDE those packages that points at
 *      another workspace package, so a published tarball depends on the
 *      exact siblings it was built and tested against rather than on
 *      whatever a range resolves to later.
 *
 * (3) is the one that is easy to forget and impossible to notice: npm will
 * happily publish a package whose sibling ranges point at an older
 * release, and it installs cleanly.
 *
 * Membership is read from the workspace itself rather than assumed from
 * the @activeledger scope. @activeledger/vm2 shares the scope and is NOT
 * in this repository - rewriting it to the monorepo's version would pin a
 * dependency to a release that does not exist, and the failure would only
 * appear at install time on someone else's machine.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: set-version.mjs <version>   e.g. 4.5.11");
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
// Trailing newline: npm writes one, and without it every release would
// show a spurious no-newline-at-end-of-file diff on all 18 manifests.
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

// Every package name this workspace actually publishes
const workspaceNames = new Set();
for (const dir of readdirSync("packages")) {
  const manifest = join("packages", dir, "package.json");
  if (!existsSync(manifest)) continue;
  const name = readJson(manifest).name;
  if (name) workspaceNames.add(name);
}

const touched = [];

const root = readJson("package.json");
root.version = version;
writeJson("package.json", root);
touched.push("package.json");

for (const dir of readdirSync("packages")) {
  const manifest = join("packages", dir, "package.json");
  if (!existsSync(manifest)) continue;

  const pkg = readJson(manifest);
  if (!pkg.name) continue;

  pkg.version = version;

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      // Exact, not a range. These are released as a set.
      if (workspaceNames.has(name)) deps[name] = version;
    }
  }

  writeJson(manifest, pkg);
  touched.push(manifest);
}

console.log(`Set ${version} across ${touched.length} manifests`);
