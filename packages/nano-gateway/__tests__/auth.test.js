const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ActiveCrypto } = require("@activeledger/activecrypto");
const { Allowlist } = require("../lib/allowlist.js");
const { verifyHandshake } = require("../lib/auth.js");

function makeKeyPair() {
  const generator = new ActiveCrypto.KeyPair("secp256k1");
  return generator.generate();
}

function sign(prvPem, payload) {
  return new ActiveCrypto.KeyPair("secp256k1", prvPem).sign(payload);
}

function fakeAllowlist(approvedIdentities) {
  return { isApproved: (id) => approvedIdentities.includes(id) };
}

function fakeDb(docsById) {
  return {
    async get(id) {
      const doc = docsById[id];
      if (!doc) throw new Error("not found");
      return doc;
    },
  };
}

test("verifyHandshake: a correctly signed, allow-listed, fresh handshake passes", async () => {
  const key = makeKeyPair();
  const identity = "nano-1";
  const timestamp = String(Date.now());
  const payload = `${identity}:${timestamp}`;
  const signature = sign(key.prv.pkcs8pem, payload);

  const db = fakeDb({ [`${identity}:stream`]: { authorities: [{ public: key.pub.pkcs8pem, type: "secp256k1" }] } });
  const allowlist = fakeAllowlist([identity]);

  const result = await verifyHandshake({ identity, timestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, true);
});

test("verifyHandshake: rejects an identity not on the allowlist, before ever touching the DB", async () => {
  const key = makeKeyPair();
  const identity = "nano-1";
  const timestamp = String(Date.now());
  const signature = sign(key.prv.pkcs8pem, `${identity}:${timestamp}`);

  let dbTouched = false;
  const db = { async get() { dbTouched = true; throw new Error("should not be called"); } };
  const allowlist = fakeAllowlist([]); // nothing approved

  const result = await verifyHandshake({ identity, timestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not on the allowlist/);
  assert.equal(dbTouched, false, "allowlist check must short-circuit before any DB read");
});

test("verifyHandshake: rejects a stale timestamp outside the auth window", async () => {
  const key = makeKeyPair();
  const identity = "nano-1";
  const staleTimestamp = String(Date.now() - 5 * 60 * 1000); // 5 minutes old
  const signature = sign(key.prv.pkcs8pem, `${identity}:${staleTimestamp}`);

  const db = fakeDb({ [`${identity}:stream`]: { authorities: [{ public: key.pub.pkcs8pem, type: "secp256k1" }] } });
  const allowlist = fakeAllowlist([identity]);

  const result = await verifyHandshake({ identity, timestamp: staleTimestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, false);
  assert.match(result.reason, /window/);
});

test("verifyHandshake: rejects a signature that doesn't verify against the identity's on-ledger key", async () => {
  const realKey = makeKeyPair();
  const attackerKey = makeKeyPair();
  const identity = "nano-1";
  const timestamp = String(Date.now());
  // Signed with the WRONG key.
  const signature = sign(attackerKey.prv.pkcs8pem, `${identity}:${timestamp}`);

  const db = fakeDb({ [`${identity}:stream`]: { authorities: [{ public: realKey.pub.pkcs8pem, type: "secp256k1" }] } });
  const allowlist = fakeAllowlist([identity]);

  const result = await verifyHandshake({ identity, timestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not verify/);
});

test("verifyHandshake: rejects when the identity has no on-ledger record at all", async () => {
  const key = makeKeyPair();
  const identity = "nano-ghost";
  const timestamp = String(Date.now());
  const signature = sign(key.prv.pkcs8pem, `${identity}:${timestamp}`);

  const db = fakeDb({}); // nothing on the ledger
  const allowlist = fakeAllowlist([identity]);

  const result = await verifyHandshake({ identity, timestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no on-ledger record/);
});

test("verifyHandshake: a signature valid against the second of several authorities still passes", async () => {
  const oldKey = makeKeyPair();
  const currentKey = makeKeyPair();
  const identity = "nano-1";
  const timestamp = String(Date.now());
  const signature = sign(currentKey.prv.pkcs8pem, `${identity}:${timestamp}`);

  const db = fakeDb({
    [`${identity}:stream`]: {
      authorities: [
        { public: oldKey.pub.pkcs8pem, type: "secp256k1" },
        { public: currentKey.pub.pkcs8pem, type: "secp256k1" },
      ],
    },
  });
  const allowlist = fakeAllowlist([identity]);

  const result = await verifyHandshake({ identity, timestamp, signature }, allowlist, db, 60);
  assert.equal(result.ok, true);
});

test("verifyHandshake: rejects missing headers cleanly, not a throw", async () => {
  const db = fakeDb({});
  const allowlist = fakeAllowlist(["nano-1"]);
  const result = await verifyHandshake({ identity: "nano-1" }, allowlist, db, 60);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing/);
});
