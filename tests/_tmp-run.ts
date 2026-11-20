import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Keeps what the tests leave in the temp folder in one place, and removes it.
 *
 * Many tests make a folder with fs.mkdtemp under os.tmpdir() and never remove
 * it, so every run of the suite left several thousand folders in /tmp (and the
 * folders of the programs the tests start, which inherit TMPDIR). These root
 * hooks point TMPDIR at one folder for the run and delete it afterwards.
 *
 * os.tmpdir() reads TMPDIR each time it is called, so this covers everything
 * that asks after the first test starts. A test that names /tmp itself, or
 * asks at import time, is not covered and behaves as before.
 */
let runDir: string | undefined;
let savedTmp: string | undefined;

before(() => {
  savedTmp = process.env.TMPDIR;
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-test-run-"));
  process.env.TMPDIR = runDir;
});

after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (runDir) {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {
      // Something still has it open; the next run makes its own
    }
  }
});
