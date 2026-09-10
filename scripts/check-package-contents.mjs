#!/usr/bin/env node
/**
 * Fails if any package would publish a tarball that cannot be required.
 *
 * v4.5.11 through v4.5.13 shipped @activeledger/activestorage with no lib/
 * at all. Its package.json still said `main: "./lib/index.js"`, so every
 * one of those releases threw MODULE_NOT_FOUND on require() - the package
 * was on the registry, resolvable, the right version, and unusable.
 *
 * The cause: `packages/.gitignore` ignores `lib` and `es`, and npm falls
 * back to .gitignore when a package has no `files` field and no
 * .npmignore. Every other package declares `files: ["es", "lib"]`, which
 * overrides that. activestorage was the only one that did not, so it was
 * the only one whose build output was silently dropped. Under lerna this
 * never showed, because lerna packed by its own rules; dropping lerna in
 * 4.5.11 handed packing to npm and the latent bug became live.
 *
 * Nothing caught it. The release workflow verifies each version is
 * FETCHABLE from the registry, which it was. Being fetchable is not the
 * same as being usable, and no test imports the published artefact. It
 * took a deploy failing on someone else's machine to notice.
 *
 * So this asserts the weakest thing that would have caught it: whatever
 * `main`, `types` and `module` point at must actually be inside the
 * tarball. Run it after a build - `npm pack` runs `prepack`, not
 * `prepublishOnly`, so it does not build for you.
 */
import { execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The fields that name an entry point a consumer will actually resolve.
const ENTRY_FIELDS = ["main", "types", "typings", "module"];

const problems = [];
const notBuilt = [];
let checked = 0;

for (const dir of readdirSync("packages")) {
  const manifestPath = join("packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;

  const pkg = readJson(manifestPath);
  if (!pkg.name || pkg.private) continue;

  const entries = ENTRY_FIELDS.filter((f) => typeof pkg[f] === "string").map(
    (f) => [f, pkg[f].replace(/^\.\//, "")]
  );
  if (!entries.length) continue;

  let listed;
  try {
    // --json gives the exact file list npm would ship, which is the only
    // thing worth asserting against. Reading the directory instead would
    // miss the whole failure mode: the files were on disk, and npm left
    // them out.
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: join("packages", dir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
    listed = new Set(JSON.parse(out)[0].files.map((f) => f.path));
  } catch (e) {
    problems.push(`${pkg.name}: could not compute tarball contents (${e.message})`);
    continue;
  }

  checked++;
  for (const [field, target] of entries) {
    // Only assert against what has actually been built. A package that is
    // not built yet has nothing to exclude, and failing on it would report
    // the wrong thing: nano-gateway is deliberately outside the root build
    // chain and builds itself from prepublishOnly at publish time, so its
    // output is legitimately absent here and its published tarball is fine.
    //
    // The bug being guarded against is narrower and entirely different:
    // the file is ON DISK and npm leaves it OUT. That is the only case
    // this fails on, which keeps the check quiet enough to be trusted.
    if (!existsSync(join("packages", dir, target))) {
      notBuilt.push(`${pkg.name} (${field} -> ${target})`);
      continue;
    }
    if (!listed.has(target)) {
      problems.push(
        `${pkg.name}: ${field} is "${pkg[field]}" and ${target} exists on disk, ` +
          `but npm leaves it OUT of the tarball (${listed.size} files). Add a ` +
          `"files" entry covering it - a package whose entry point is missing ` +
          `installs fine, resolves fine, and throws MODULE_NOT_FOUND on require.`
      );
    }
  }
}

if (problems.length) {
  console.error("Packages that would publish an unusable tarball:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n${problems.length} problem(s) across ${checked} package(s) checked.`
  );
  process.exit(1);
}

if (notBuilt.length) {
  // Not a failure: these build themselves at publish time. Printed so an
  // empty pass is never mistaken for full coverage.
  console.log(`Not built here, so not checked (built at publish time):`);
  for (const n of notBuilt) console.log(`  - ${n}`);
}

console.log(`All ${checked} publishable packages ship the entry points they have built.`);
