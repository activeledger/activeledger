#!/usr/bin/env node
/**
 * Makes packages/activeledger/README.md (the page npm shows for @activeledger/activeledger) from the root README.md,
 * so the two cannot drift. What changes: relative links become absolute (guide pages on the docs site, other files on
 * GitHub), images are read from raw.githubusercontent.com, and the lines about working in the repository are dropped.
 *
 *   node scripts/sync-readme.mjs          write the file
 *   node scripts/sync-readme.mjs --check  exit 1 if it is out of date (the unit suite runs this)
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const SITE = "https://activeledger.github.io/activeledger/";
const BLOB = "https://github.com/activeledger/activeledger/blob/master/";
const RAW = "https://raw.githubusercontent.com/activeledger/activeledger/master/";

/** docs/guide/cli/project.md#x -> https://.../cli/project/#x ; index.md -> the site root */
const guideUrl = (rel) => {
  const [file, anchor] = rel.split("#");
  const page = file.replace(/^docs\/guide\//, "").replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "/");
  return SITE + (page === "/" ? "" : page) + (anchor ? "#" + anchor : "");
};

export const transform = (root) => {
  let text = root;
  // Images first (they also match the link pattern below)
  text = text.replace(/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g, (_m, alt, src) => `![${alt}](${RAW}${src})`);
  text = text.replace(/srcset="(?!https?:)([^"]+)"/g, (_m, src) => `srcset="${RAW}${src}"`);
  text = text.replace(/<img src="(?!https?:)([^"]+)"/g, (_m, src) => `<img src="${RAW}${src}"`);
  // Links
  text = text.replace(/(?<!!)\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_m, target) =>
    `](${target.startsWith("docs/guide/") ? guideUrl(target) : BLOB + target})`
  );
  // Working in the repository is for the repository's page
  text = text.replace(/^- \[Developing Activeledger\]\([^)]*\)[^\n]*\n/m, "");
  return text;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const rootFile = path.join(here, "..", "README.md");
const pkgFile = path.join(here, "..", "packages", "activeledger", "README.md");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = transform(readFileSync(rootFile, "utf8"));
  if (process.argv.includes("--check")) {
    if (readFileSync(pkgFile, "utf8") !== out) {
      console.error("packages/activeledger/README.md is out of date: run `node scripts/sync-readme.mjs`");
      process.exit(1);
    }
  } else {
    writeFileSync(pkgFile, out);
    console.log("wrote packages/activeledger/README.md");
  }
}
