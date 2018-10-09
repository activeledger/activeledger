import { ActiveCrypto } from "../packages/activecrypto/src";
import { expect, should } from "chai";
import "mocha";

describe("Cryptographic Test (Activecrypto)", () => {
  // Some Random Test Data
  const random = Math.floor(Math.random() * 100000000 + 1).toString();

  let rsa: ActiveCrypto.KeyHandler;
  let elliptic: ActiveCrypto.KeyHandler;
  let encrypt: string;

  it("should create a new RSA key", () => {
    rsa = new ActiveCrypto.KeyPair("rsa").generate();
    expect(rsa)
      .to.be.an("object")
      .and.property("prv")
      .that.is.an("object")
      .and.has.property("pkcs8pem")
      .that.is.a("string")
      .to.have.length.above(1700);
  }).timeout(10000);

  it("RSA should sign and verify", () => {
    let keyPriv = new ActiveCrypto.KeyPair("rsa", rsa.prv.pkcs8pem);
    let keyPublic = new ActiveCrypto.KeyPair("rsa", rsa.pub.pkcs8pem);
    let signature = keyPriv.sign(random);
    expect(signature).to.be.an("string");
    let verify = keyPublic.verify(random, signature);
    expect(verify).to.be.an("boolean");
  }).timeout(5000);

  it("RSA should encrypt", () => {
    let keyPublic = new ActiveCrypto.KeyPair("rsa", rsa.pub.pkcs8pem);
    encrypt = keyPublic.encrypt(random);
    expect(encrypt).to.be.an("string");
  }).timeout(5000);

  it("RSA should decrypt and match", () => {
    let keyPriv = new ActiveCrypto.KeyPair("rsa", rsa.prv.pkcs8pem);
    expect(keyPriv.decrypt(encrypt))
      .to.be.an("string")
      .and.equal(Buffer.from(random).toString("base64"));
  }).timeout(5000);

  it("should create a new elliptic key", () => {
    elliptic = new ActiveCrypto.KeyPair("secp256k1").generate();
    expect(elliptic)
      .to.be.an("object")
      .and.property("prv")
      .that.is.an("object")
      .and.has.property("pkcs8pem")
      .that.is.a("string")
      .to.have.length.above(110);
  }).timeout(5000);

  it("Elliptic should sign and verify", () => {
    let keyPriv = new ActiveCrypto.KeyPair("secp256k1", elliptic.prv.pkcs8pem);
    let keyPublic = new ActiveCrypto.KeyPair(
      "secp256k1",
      elliptic.pub.pkcs8pem
    );
    let signature = keyPriv.sign(random);
    expect(signature).to.be.an("string");
    let verify = keyPublic.verify(random, signature);
    expect(verify).to.be.an("boolean");
  }).timeout(5000);

  // it("Elliptic should throw on encrypt", () => {
  //   should().throw(() => {
  //     let keyPublic = new ActiveCrypto.KeyPair(
  //       "secp256k1",
  //       elliptic.pub.pkcs8pem
  //     );
  //     encrypt = keyPublic.encrypt(random);
  //   });
  // });

  // it("Elliptic should throw on decrypt", () => {
  //   should().throw(() => {
  //     let keyPublic = new ActiveCrypto.KeyPair(
  //       "secp256k1",
  //       elliptic.pub.pkcs8pem
  //     );
  //     encrypt = keyPublic.decrypt(random);
  //   });
  // });
});
