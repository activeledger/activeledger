import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import Hybrid from "../packages/activeledger/src/contracts/default/hybrid";
import { identityFrom } from "../packages/hybrid/src/http-upstream";
import { interpret, parseEndpoint, registerTx, retireTx, updateTx, registryStreamId } from "../packages/hybrid/src/registry";

const kp = new ActiveCrypto.KeyPair("rsa");
const generated = kp.generate();
const identity = identityFrom({ prv: { pkcs8pem: generated.prv.pkcs8pem }, pub: { pkcs8pem: generated.pub.pkcs8pem } });
const endpoints = [parseEndpoint("p2p://hybrid.example:5271")];
const NOW = 1_000_000;

describe("hybrid registry transactions", () => {
  it("parses endpoints strictly", () => {
    expect(parseEndpoint("p2p://h:1")).to.deep.equal({ transport: "p2p", host: "h", port: 1 });
    expect(parseEndpoint("http://[::1]:5260")).to.deep.equal({ transport: "http", host: "::1", port: 5260 });
    for (const bad of ["h:1", "ftp://h:1", "p2p://h", "p2p://h:0", "p2p://h:65536", "p2p://:1"]) {
      expect(() => parseEndpoint(bad), bad).to.throw();
    }
  });

  it("builds a register that the contract's own validation accepts, signed by the key", () => {
    const tx = registerTx(identity, endpoints, "mine", NOW);
    const input = (tx.$tx as any).$i[identity.keyHash];
    expect(Hybrid.validateKey(input.type, input.publicKey)).to.equal(null);
    expect(Hybrid.validateEndpoints(input.endpoints)).to.equal(null);
    expect(Hybrid.validateLabel(input.label)).to.equal(null);
    expect(tx.$selfsign).to.equal(true);
    expect(new ActiveCrypto.KeyPair("rsa", identity.publicPem).verify(tx.$tx as any, tx.$sigs[identity.keyHash])).to.equal(true);
    expect((tx.$tx as any).$namespace).to.equal("default");
    expect((tx.$tx as any).$contract).to.equal("hybrid");
    expect((tx.$tx as any).$expire).to.equal(new Date(NOW + 300000).toISOString());
  });

  it("omits an empty label", () => {
    expect((registerTx(identity, endpoints, undefined, NOW).$tx as any).$i[identity.keyHash]).to.not.have.property("label");
  });

  it("addresses update and retire to the key's registry stream, signed, not self-signed", () => {
    const id = registryStreamId(identity);
    expect(id).to.equal(ActiveCrypto.hybridStreamId(identity.publicPem));
    for (const tx of [updateTx(identity, endpoints, NOW), retireTx(identity, NOW)]) {
      expect(Object.keys((tx.$tx as any).$i)).to.deep.equal([id]);
      expect(tx.$selfsign).to.equal(undefined);
      expect(new ActiveCrypto.KeyPair("rsa", identity.publicPem).verify(tx.$tx as any, tx.$sigs[id])).to.equal(true);
    }
    expect((updateTx(identity, endpoints, NOW).$tx as any).$i[id]).to.deep.equal({ endpoints });
  });

  it("reads a supernode answer", () => {
    expect(interpret({ $summary: { commit: 1 } })).to.deep.equal({ ok: true, alreadyRegistered: false, errors: [] });
    expect(interpret({ $summary: { errors: ["1530 collision on stream"] } })).to.include({ ok: false, alreadyRegistered: true });
    expect(interpret({ $summary: { errors: ["Invalid public key"] } })).to.include({ ok: false, alreadyRegistered: false });
    expect(interpret({ error: "Transaction Expired" }).ok).to.equal(false);
    expect(interpret(undefined).ok).to.equal(true);
  });
});
