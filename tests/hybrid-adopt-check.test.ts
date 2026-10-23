import {
  checkAdopt,
  documentSha256,
  matchesRevOut,
  IAdoptCheck,
} from "../packages/protocol/src/protocol/adopt";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";

// The adopt safety net: before a hybrid saves the supernodes' signed
// documents in place of its own result, the documents may differ from its
// own only where the contract declared they would.
describe("Hybrid adopt safety-net check (Activeprotocol)", () => {
  const UMID = "umid-adopt";
  const W = "a".repeat(64); // wallet
  const B1 = "b".repeat(64); // candidate balance
  const B2 = "c".repeat(64); // candidate balance

  const wallet = (extra: any = {}) => ({
    _id: W,
    _rev: "2-local",
    owner: "alice",
    status: "pending",
    ...extra,
  });
  const signedWallet = (extra: any = {}) => ({
    ...wallet(),
    _rev: "3-signed",
    signature: "sig",
    status: "signed",
    ...extra,
  });

  const declared = (shape: any, opts: any = {}): any => ({
    streams: [W],
    shape,
    atomic: !!opts.atomic,
    candidates: false,
  });

  const check = (input: Partial<IAdoptCheck>) =>
    checkAdopt({
      umid: UMID,
      signed: {},
      local: {},
      declarations: [],
      supernodeDependent: true,
      ...input,
    });

  describe("sha256 helpers", () => {
    it("hash the canonical JSON of the stored document", () => {
      const doc = { b: 1, _id: "x", a: { d: 2, c: 3 }, _rev: "1-x" };
      expect(documentSha256(doc)).to.equal(
        ActiveCrypto.Hash.getHash('{"_id":"x","_rev":"1-x","a":{"c":3,"d":2},"b":1}')
      );
      expect(documentSha256(doc)).to.equal(
        documentSha256({ _rev: "1-x", a: { c: 3, d: 2 }, _id: "x", b: 1 })
      );
    });

    it("match a document to its revsOut entry by rev and sha256", () => {
      const doc = { _id: "x", _rev: "1-x", v: 1 };
      const revOut = { rev: "1-x", sha256: documentSha256(doc) };
      expect(matchesRevOut(doc, revOut)).to.equal(true);
      expect(matchesRevOut({ ...doc, v: 2 }, revOut)).to.equal(false);
      expect(matchesRevOut({ ...doc, _rev: "2-x" }, revOut)).to.equal(false);
      expect(matchesRevOut(undefined, revOut)).to.equal(false);
    });
  });

  describe("undeclared", () => {
    it("adopts every signed document whole when the execution was supernode-dependent", () => {
      const verdict = check({
        signed: { [W]: signedWallet({ owner: "mallory" }) },
        local: { [W]: wallet() },
      });
      expect(verdict).to.deep.equal({ ok: true, mode: "undeclared", reasons: [] });
    });

    it("even with no local counterpart", () => {
      const verdict = check({ signed: { [W]: signedWallet() } });
      expect(verdict.ok).to.equal(true);
      expect(verdict.mode).to.equal("undeclared");
    });
  });

  it("rejects adoption of an execution that was not supernode-dependent", () => {
    const verdict = check({
      supernodeDependent: false,
      signed: { [W]: signedWallet() },
      local: { [W]: wallet() },
      declarations: [declared({ signature: "string", status: "string" })],
    });
    expect(verdict.ok).to.equal(false);
    expect(verdict.reasons).to.deep.equal(["execution was not supernode-dependent"]);
  });

  describe("declared", () => {
    const shape = { signature: "string", status: "string" };

    it("accepts a document that differs only in declared properties", () => {
      const verdict = check({
        signed: { [W]: signedWallet() },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict).to.deep.equal({ ok: true, mode: "verified", reasons: [] });
    });

    it("accepts an identical document (ignoring _rev)", () => {
      const verdict = check({
        signed: { [W]: { ...wallet(), _rev: "9-other" } },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.ok).to.equal(true);
    });

    it("rejects a change outside the declared properties", () => {
      const verdict = check({
        signed: { [W]: signedWallet({ owner: "mallory" }) },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.reasons).to.deep.equal([
        `${W}: differs outside the declared properties`,
      ]);
    });

    it("rejects a property the supernode removed that was not declared", () => {
      const { owner, ...withoutOwner } = signedWallet();
      const verdict = check({
        signed: { [W]: withoutOwner },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([
        `${W}: differs outside the declared properties`,
      ]);
    });

    it("rejects a declared property of the wrong type", () => {
      const verdict = check({
        signed: { [W]: signedWallet({ signature: 42 }) },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([`${W}.signature: is not string`]);
    });

    it("checks every type", () => {
      const all = {
        s: "string",
        n: "number",
        b: "boolean",
        o: "object",
        a: "array",
        x: "any",
      };
      const good = { s: "x", n: 1, b: false, o: { k: 1 }, a: [1], x: null };
      expect(
        check({
          signed: { [W]: { ...wallet(), ...good } },
          local: { [W]: wallet() },
          declarations: [declared(all)],
        }).ok
      ).to.equal(true);

      const bad = { s: 1, n: "1", b: "false", o: [1], a: { 0: 1 }, x: 1 };
      expect(
        check({
          signed: { [W]: { ...wallet(), ...bad } },
          local: { [W]: wallet() },
          declarations: [declared(all)],
        }).reasons
      ).to.deep.equal([
        `${W}.s: is not string`,
        `${W}.n: is not number`,
        `${W}.b: is not boolean`,
        `${W}.o: is not object`,
        `${W}.a: is not array`,
      ]);
    });

    it("rejects a required declared property that is missing", () => {
      const { signature, ...unsigned } = signedWallet();
      const verdict = check({
        signed: { [W]: unsigned },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([
        `${W}.signature: declared property is missing`,
      ]);
    });

    describe("optional", () => {
      it("may be absent", () => {
        const verdict = check({
          signed: { [W]: signedWallet() },
          local: { [W]: wallet() },
          declarations: [declared({ ...shape, broadcastedAt: "number?" })],
        });
        expect(verdict.ok).to.equal(true);
      });

      it("may be deleted by the supernode", () => {
        const verdict = check({
          signed: { [W]: signedWallet() },
          local: { [W]: wallet({ broadcastedAt: 1 }) },
          declarations: [declared({ ...shape, broadcastedAt: "number?" })],
        });
        expect(verdict.ok).to.equal(true);
      });

      it("must have its type when present", () => {
        const verdict = check({
          signed: { [W]: signedWallet({ broadcastedAt: "soon" }) },
          local: { [W]: wallet() },
          declarations: [declared({ ...shape, broadcastedAt: "number?" })],
        });
        expect(verdict.reasons).to.deep.equal([`${W}.broadcastedAt: is not number`]);
      });
    });

    describe("nested descriptions", () => {
      const nested = { chain: { txid: "string", height: "number?" } };

      it("adopt only the declared nested properties", () => {
        const verdict = check({
          signed: { [W]: wallet({ chain: { net: "main", txid: "t1" } }) },
          local: { [W]: wallet({ chain: { net: "main" } }) },
          declarations: [declared(nested)],
        });
        expect(verdict.ok).to.equal(true);
      });

      it("reject a change to an undeclared sibling", () => {
        const verdict = check({
          signed: { [W]: wallet({ chain: { net: "test", txid: "t1" } }) },
          local: { [W]: wallet({ chain: { net: "main" } }) },
          declarations: [declared(nested)],
        });
        expect(verdict.reasons).to.deep.equal([
          `${W}: differs outside the declared properties`,
        ]);
      });

      it("type-check the nested properties", () => {
        const verdict = check({
          signed: { [W]: wallet({ chain: { net: "main", txid: 7 } }) },
          local: { [W]: wallet({ chain: { net: "main" } }) },
          declarations: [declared(nested)],
        });
        expect(verdict.reasons).to.deep.equal([`${W}.chain.txid: is not string`]);
      });

      it("require the nested object itself", () => {
        const verdict = check({
          signed: { [W]: wallet({ chain: "none", status: "x" }) },
          local: { [W]: wallet({ chain: { net: "main" } }) },
          declarations: [declared({ ...nested, status: "string" })],
        });
        expect(verdict.reasons).to.include(`${W}.chain: is not object`);
        expect(verdict.reasons).to.include(
          `${W}: differs outside the declared properties`
        );
      });
    });

    describe("atomic", () => {
      const atomicShape = { a: "string", b: "string", c: "string" };
      const base = wallet({ a: "1", b: "1", c: "1" });

      it("accepts all declared properties changing", () => {
        const verdict = check({
          signed: { [W]: { ...base, a: "2", b: "2", c: "2" } },
          local: { [W]: base },
          declarations: [declared(atomicShape, { atomic: true })],
        });
        expect(verdict.ok).to.equal(true);
      });

      it("accepts none changing", () => {
        const verdict = check({
          signed: { [W]: { ...base, _rev: "3-x" } },
          local: { [W]: base },
          declarations: [declared(atomicShape, { atomic: true })],
        });
        expect(verdict.ok).to.equal(true);
      });

      it("rejects some but not all changing", () => {
        const verdict = check({
          signed: { [W]: { ...base, a: "2", b: "2" } },
          local: { [W]: base },
          declarations: [declared(atomicShape, { atomic: true })],
        });
        expect(verdict.reasons).to.deep.equal([
          `${W}: atomic declaration changed 2 of 3 properties (a, b)`,
        ]);
      });

      it("counts an optional property appearing as a change", () => {
        const verdict = check({
          signed: { [W]: { ...base, a: "2", d: "new" } },
          local: { [W]: base },
          declarations: [declared({ a: "string", d: "string?" }, { atomic: true })],
        });
        expect(verdict.ok).to.equal(true);

        const partial = check({
          signed: { [W]: { ...base, d: "new" } },
          local: { [W]: base },
          declarations: [declared({ a: "string", d: "string?" }, { atomic: true })],
        });
        expect(partial.reasons).to.deep.equal([
          `${W}: atomic declaration changed 1 of 2 properties (d)`,
        ]);
      });

      it("does not constrain a non-atomic declaration", () => {
        const verdict = check({
          signed: { [W]: { ...base, a: "2" } },
          local: { [W]: base },
          declarations: [declared(atomicShape)],
        });
        expect(verdict.ok).to.equal(true);
      });
    });

    it("rejects a signed document with no local counterpart", () => {
      const created = "d".repeat(64);
      const verdict = check({
        signed: { [W]: signedWallet(), [created]: { _id: created, _rev: "1-x" } },
        local: { [W]: wallet() },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([
        `${created}: signed document has no local counterpart`,
      ]);
    });

    it("rejects a changed stream that has no declaration", () => {
      const other = "e".repeat(64);
      const verdict = check({
        signed: {
          [W]: signedWallet(),
          [other]: { _id: other, _rev: "2-y", v: 2 },
        },
        local: { [W]: wallet(), [other]: { _id: other, _rev: "1-y", v: 1 } },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([
        `${other}: differs, and the stream has no adopt declaration`,
      ]);
    });

    it("rejects a changed meta or contract data document", () => {
      const verdict = check({
        signed: {
          [W]: signedWallet(),
          [`${W}:stream`]: { _id: `${W}:stream`, _rev: "3-m", umid: UMID, name: "evil" },
          "contract:data": { _id: "contract:data", _rev: "2-d", data: { n: 2 } },
        },
        local: {
          [W]: wallet(),
          [`${W}:stream`]: { _id: `${W}:stream`, _rev: "2-m", umid: UMID, name: "w" },
          "contract:data": { _id: "contract:data", _rev: "1-d", data: { n: 1 } },
        },
        declarations: [declared(shape)],
      });
      expect(verdict.reasons).to.deep.equal([
        `${W}:stream: differs, and it cannot be declared`,
        "contract:data: differs, and it cannot be declared",
      ]);
    });

    it("accepts identical meta and contract data", () => {
      const meta = { _id: `${W}:stream`, umid: UMID, name: "w" };
      const data = { _id: "contract:data", data: { n: 1 } };
      const verdict = check({
        signed: {
          [W]: signedWallet(),
          [`${W}:stream`]: { ...meta, _rev: "3-m" },
          "contract:data": { ...data, _rev: "2-d" },
        },
        local: {
          [W]: wallet(),
          [`${W}:stream`]: { ...meta, _rev: "2-m" },
          "contract:data": { ...data, _rev: "1-d" },
        },
        declarations: [declared(shape)],
      });
      expect(verdict.ok).to.equal(true);
    });

    it("joins several declarations on one stream", () => {
      const verdict = check({
        signed: { [W]: signedWallet() },
        local: { [W]: wallet() },
        declarations: [declared({ signature: "string" }), declared({ status: "string" })],
      });
      expect(verdict.ok).to.equal(true);
    });
  });

  describe("adoptStreamsFromSupernode candidates", () => {
    const candidates = (opts: any = {}): any => ({
      streams: [B1, B2],
      shape: { balance: "number" },
      atomic: !!opts.atomic,
      candidates: true,
    });
    const balance = (id: string, value: number, rev = "1-x") => ({
      _id: id,
      _rev: rev,
      balance: value,
      owner: id.slice(0, 4),
    });
    const meta = (id: string, umid: string, rev = "1-m") => ({
      _id: `${id}:stream`,
      _rev: rev,
      umid,
      name: id.slice(0, 4),
    });

    it("accepts a changed candidate the dry run did not write, its meta moved to this transaction", () => {
      const verdict = check({
        signed: {
          [B1]: balance(B1, 150, "2-x"),
          [`${B1}:stream`]: meta(B1, UMID, "2-m"),
        },
        local: {},
        before: { [B1]: balance(B1, 100), [`${B1}:stream`]: meta(B1, "earlier") },
        declarations: [candidates()],
      });
      expect(verdict).to.deep.equal({ ok: true, mode: "verified", reasons: [] });
    });

    it("accepts an unchanged candidate", () => {
      const verdict = check({
        signed: { [B2]: balance(B2, 100, "1-x") },
        local: {},
        before: { [B2]: balance(B2, 100) },
        declarations: [candidates()],
      });
      expect(verdict.ok).to.equal(true);
    });

    it("rejects a candidate changed outside the shape", () => {
      const verdict = check({
        signed: { [B1]: { ...balance(B1, 150, "2-x"), owner: "mallory" } },
        before: { [B1]: balance(B1, 100) },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([
        `${B1}: differs outside the declared properties`,
      ]);
    });

    it("rejects a changed stream that is not a listed candidate", () => {
      const other = "f".repeat(64);
      const verdict = check({
        signed: { [other]: balance(other, 150, "2-x") },
        before: { [other]: balance(other, 100) },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([
        `${other}: differs, and the stream has no adopt declaration`,
      ]);
    });

    it("rejects meta of an untouched stream that moved somewhere else", () => {
      const verdict = check({
        signed: { [`${B1}:stream`]: meta(B1, "another-umid", "2-m") },
        before: { [`${B1}:stream`]: meta(B1, "earlier") },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([
        `${B1}:stream: differs, and it cannot be declared`,
      ]);
    });

    it("rejects a candidate with no local document at all", () => {
      const verdict = check({
        signed: { [B1]: balance(B1, 150, "2-x") },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([
        `${B1}: signed document has no local counterpart`,
      ]);
    });

    it("type-checks the candidate shape", () => {
      const verdict = check({
        signed: { [B1]: { ...balance(B1, 0, "2-x"), balance: "lots" } },
        before: { [B1]: balance(B1, 100) },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([`${B1}.balance: is not number`]);
    });

    it("prefers the dry-run document over the one at $revs", () => {
      const verdict = check({
        signed: { [B1]: balance(B1, 150, "2-x") },
        local: { [B1]: { ...balance(B1, 100), owner: "changed-locally" } },
        before: { [B1]: balance(B1, 100) },
        declarations: [candidates()],
      });
      expect(verdict.reasons).to.deep.equal([
        `${B1}: differs outside the declared properties`,
      ]);
    });
  });
});
