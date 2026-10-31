import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";

/**
 * Secured is the $ADAC (Activeledger Data Access Controller) envelope: data
 * marked with $ADAR roles is AES-256-GCM encrypted under per-role passwords,
 * and those passwords are RSA-encrypted to each recipient (a node, a stream
 * or a raw public key). Nothing exercised it before, so these use real RSA
 * keys and real round trips.
 */

const { Secured, ADACType, KeyPair } = ActiveCrypto;

function rsa() {
  const g = new KeyPair("rsa").generate();
  return { pub: g.pub.pkcs8pem, prv: g.prv.pkcs8pem };
}

const own = rsa();
const self = { reference: "node0", public: own.pub, private: own.prv };
const peer = rsa();

/**
 * What a recipient can recover: their role passwords, via their private key.
 */
function recoverPasswords(entry: any, prv: string): any {
  return JSON.parse(new KeyPair("rsa", prv).decrypt(entry.roles));
}

function openData(secured: any, enc: any, passwords: any): Promise<any> {
  return secured.deepMapDecrypt(enc.data, passwords);
}

function packetFor(recipients: any[], data: any): any {
  return { $ADAC: recipients, data };
}

describe("Secured ($ADAC envelopes)", () => {
  const db: any = { get: async () => { throw new Error("missing"); } };
  const neighbour = { node1: { identity: { pem: peer.pub } } };

  it("encrypts only the marked branch and round-trips with the recipient's role passwords", async () => {
    const secured = new Secured(db, neighbour, self);
    const enc: any = await secured.encrypt(
      packetFor([{ ref: "node0", type: ADACType.Node, roles: ["admin"] }], {
        open: "visible",
        vault: { $ADAR: "admin", secret: "s3cret", nested: { n: 1 } },
      })
    );

    expect(enc.data.open).to.equal("visible");
    expect(enc.data.vault.$ADAR).to.equal("admin");
    expect(enc.data.vault.$ADENC).to.be.a("string");
    expect(JSON.stringify(enc)).to.not.contain("s3cret");

    const dec = await openData(secured, enc, recoverPasswords(enc.$ADAC[0], self.private));
    expect(dec.open).to.equal("visible");
    expect(dec.vault.secret).to.equal("s3cret");
    expect(dec.vault.nested).to.deep.equal({ n: 1 });
  });

  it("encrypts a nested $ADAR block inside another and opens both layers", async () => {
    const secured = new Secured(db, neighbour, self);
    const enc: any = await secured.encrypt(
      packetFor([{ ref: "node0", type: ADACType.Node, roles: ["admin", "audit"] }], {
        outer: { $ADAR: "admin", a: 1, inner: { $ADAR: "audit", b: 2 } },
      })
    );
    expect(enc.data.outer.$ADENC).to.be.a("string");

    const dec = await openData(secured, enc, recoverPasswords(enc.$ADAC[0], self.private));
    expect(dec.outer.a).to.equal(1);
    expect(dec.outer.inner.b).to.equal(2);
  });

  it("only gives the recipient's own key access to the role passwords", async () => {
    const enc: any = await new Secured(db, neighbour, self).encrypt(
      packetFor([{ ref: "node1", type: ADACType.Node, roles: ["admin"] }], {
        vault: { $ADAR: "admin", secret: "s3cret" },
      })
    );

    // Encrypted to node1's key: node0's private key cannot open the roles
    expect(() => recoverPasswords(enc.$ADAC[0], self.private)).to.throw();
    expect(recoverPasswords(enc.$ADAC[0], peer.prv)).to.have.property("admin");

    // And without the password the data stays opaque to decrypt()
    const dec: any = await new Secured(db, neighbour, self).decrypt(enc);
    expect(dec.data.vault.$ADENC).to.be.a("string");
    expect(dec.data.vault.secret).to.equal(undefined);
  });

  it("resolves a stream recipient's public key from its :stream document", async () => {
    const lookups: string[] = [];
    const streamDb: any = {
      get: async (id: string) => {
        lookups.push(id);
        return { public: peer.pub };
      },
    };
    const enc: any = await new Secured(streamDb, neighbour, self).encrypt(
      packetFor([{ ref: "abc", type: ADACType.Stream, roles: ["admin"] }], {
        vault: { $ADAR: "admin", secret: "s3cret" },
      })
    );
    expect(lookups).to.deep.equal(["abc:stream"]);
    expect(recoverPasswords(enc.$ADAC[0], peer.prv)).to.have.property("admin");
  });

  it("accepts a raw public key recipient", async () => {
    const enc: any = await new Secured(db, neighbour, self).encrypt(
      packetFor([{ ref: peer.pub, type: ADACType.PubKey, roles: ["admin"] }], {
        vault: { $ADAR: "admin", secret: "s3cret" },
      })
    );
    expect(enc.data.vault.$ADENC).to.be.a("string");
    expect(recoverPasswords(enc.$ADAC[0], peer.prv)).to.have.property("admin");
  });

  it("rejects unknown neighbours, missing streams and unknown types", async () => {
    const secured = new Secured(db, neighbour, self);
    const data = () => ({ vault: { $ADAR: "admin", x: 1 } });
    const failure = async (recipient: any) => {
      try {
        await secured.encrypt(packetFor([recipient], data()));
      } catch (e) {
        return e;
      }
    };

    expect(await failure({ ref: "ghost", type: ADACType.Node, roles: ["admin"] })).to.equal("Unknown Neighbour : ghost");
    expect(await failure({ ref: "nostream", type: ADACType.Stream, roles: ["admin"] })).to.equal("Unknown Stream : nostream");
    expect(await failure({ ref: "x", type: "bogus", roles: ["admin"] })).to.equal("Unknown $ADAC type");
  });

  it("rejects an unknown $ADAC type on decrypt", async () => {
    let err: any;
    try {
      await new Secured(db, neighbour, self).decrypt({
        $ADAC: [{ ref: "x", type: "bogus" as any, roles: "" }],
        data: {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.equal("Unknown $ADAC type");
  });

  it("returns a packet without $ADAC untouched on decrypt", async () => {
    const packet: any = { data: { a: 1 } };
    const dec: any = await new Secured(db, neighbour, self).decrypt(packet);
    expect(dec.data).to.deep.equal({ a: 1 });
  });

  it("hands every recipient of a role its own password", async () => {
    const enc: any = await new Secured(db, neighbour, self).encrypt(
      packetFor(
        [
          { ref: "node0", type: ADACType.Node, roles: ["admin"] },
          { ref: peer.pub, type: ADACType.PubKey, roles: ["admin"] },
        ],
        { vault: { $ADAR: "admin", secret: "s3cret" } }
      )
    );
    // $ADAC is processed last-to-first, so $ADAC[0] is the later recipient
    const forSelf = recoverPasswords(enc.$ADAC[0], self.private);
    const forPeer = recoverPasswords(enc.$ADAC[1], peer.prv);
    expect(forSelf).to.have.property("admin");
    expect(forPeer).to.have.property("admin");
    expect(forSelf.admin).to.equal(forPeer.admin);
  });

  it("lets a later recipient of an already-seen role open the data", async () => {
    const enc: any = await new Secured(db, neighbour, self).encrypt(
      packetFor(
        [
          // $ADAC is processed last-to-first, so node1 is the later recipient of "admin"
          { ref: "node1", type: ADACType.Node, roles: ["admin"] },
          { ref: "node0", type: ADACType.Node, roles: ["admin"] },
        ],
        { vault: { $ADAR: "admin", secret: "s3cret" } }
      )
    );
    const dec = await openData(new Secured(db, neighbour, self), enc, recoverPasswords(enc.$ADAC[0], peer.prv));
    expect(dec.vault.secret).to.equal("s3cret");
  });

  it("decrypt() opens the data for a node recipient", async () => {
    const secured = new Secured(db, neighbour, self);
    const enc: any = await secured.encrypt(
      packetFor([{ ref: "node0", type: ADACType.Node, roles: ["admin"] }], {
        open: "visible",
        vault: { $ADAR: "admin", secret: "s3cret", nested: { n: 1 } },
      })
    );
    const dec: any = await secured.decrypt(enc);
    expect(dec.data.open).to.equal("visible");
    expect(dec.data.vault.secret).to.equal("s3cret");
    expect(dec.data.vault.nested).to.deep.equal({ n: 1 });
  });

  it("rejects encrypt() with a clear error when there is no root $ADAC", async () => {
    let err: any;
    try {
      await new Secured(db, neighbour, self).encrypt({ data: { a: 1 } } as any);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.contain("$ADAC");
  });

  it("rejects decrypt() promptly when the ciphertext has been tampered with", async function () {
    this.timeout(3000);
    const secured = new Secured(db, neighbour, self);
    const enc: any = await secured.encrypt(
      packetFor([{ ref: "node0", type: ADACType.Node, roles: ["admin"] }], {
        vault: { $ADAR: "admin", secret: "s3cret" },
      })
    );
    const raw = Buffer.from(enc.data.vault.$ADENC, "base64");
    raw[raw.length - 1] ^= 0xff;
    enc.data.vault.$ADENC = raw.toString("base64");

    let err: any;
    try {
      await secured.decrypt(enc);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.contain("decrypt");
  });
});
