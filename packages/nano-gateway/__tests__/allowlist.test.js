const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Allowlist } = require("../lib/allowlist.js");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nano-gw-test-")), "allowlist.json");
}

test("Allowlist: a fresh/missing file has no approved identities", () => {
  const list = new Allowlist(tmpFile());
  assert.equal(list.isApproved("nano-1"), false);
  assert.deepEqual(list.list(), []);
});

test("Allowlist: add() then isApproved() round-trips", () => {
  const list = new Allowlist(tmpFile());
  list.add({ identity: "nano-1", label: "test device" });
  assert.equal(list.isApproved("nano-1"), true);
  assert.equal(list.isApproved("nano-2"), false);
});

test("Allowlist: add() is idempotent for the same identity", () => {
  const list = new Allowlist(tmpFile());
  list.add({ identity: "nano-1" });
  list.add({ identity: "nano-1", label: "duplicate" });
  assert.equal(list.list().length, 1);
});

test("Allowlist: remove() revokes an identity", () => {
  const list = new Allowlist(tmpFile());
  list.add({ identity: "nano-1" });
  list.remove("nano-1");
  assert.equal(list.isApproved("nano-1"), false);
});

test("Allowlist: persists across separate instances pointed at the same file", () => {
  const file = tmpFile();
  new Allowlist(file).add({ identity: "nano-1" });
  const reopened = new Allowlist(file);
  assert.equal(reopened.isApproved("nano-1"), true);
});
