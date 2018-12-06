import { ActiveCrypto } from "../packages/activecrypto/src";
import { expect, should } from "chai";
import "mocha";
import { ISecuredData } from "../packages/activecrypto/es/crypto/secured";

describe("Cryptographic Test (Activecrypto)", () => {
  // Some Random Test Data
  const random = Math.floor(Math.random() * 100000000 + 1).toString();

  let rsa: ActiveCrypto.KeyHandler;
  let elliptic: ActiveCrypto.KeyHandler;
  let encrypt: string;

  // Encrypted data test result for decrypt
  let encrypted: any;
  let pubKey =
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmAuML/GIdlOcZZ58eMHX\nSnQruMJqqR9scWSYx2iHCZ0g7Gs98E3CyulAzyYnf13Up/eXXxFCg2rwEO2EufzD\nUBsYcYlv1Rep4qqy/ThkbHpTlQd+9zo64JBRtYoJr4aRT2SfSK4R97HDYUv8fFCQ\nMMWdocj4Yqztweb+jKs+CPmT0TDU/0kwWpUQWdXHXJdGLBtnoAeOLR8za9bCao9g\nTOOUuD6VB+I7acg4zaV6WYwRGp2xRgiIcvmHeUMBGEHGo8s6N0W9K+GkTNVYggdG\noLnr/ZERsjWGGZoEh7gFpy6cLf9BYpNElWHTiV9Sgr+lPzAwnKS0tskteT+ip4Qn\nAwIDAQAB\n-----END PUBLIC KEY-----";
  let prvKey =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCYC4wv8Yh2U5xl\nnnx4wddKdCu4wmqpH2xxZJjHaIcJnSDsaz3wTcLK6UDPJid/XdSn95dfEUKDavAQ\n7YS5/MNQGxhxiW/VF6niqrL9OGRselOVB373OjrgkFG1igmvhpFPZJ9IrhH3scNh\nS/x8UJAwxZ2hyPhirO3B5v6Mqz4I+ZPRMNT/STBalRBZ1cdcl0YsG2egB44tHzNr\n1sJqj2BM45S4PpUH4jtpyDjNpXpZjBEanbFGCIhy+Yd5QwEYQcajyzo3Rb0r4aRM\n1ViCB0aguev9kRGyNYYZmgSHuAWnLpwt/0Fik0SVYdOJX1KCv6U/MDCcpLS2yS15\nP6KnhCcDAgMBAAECggEAEyrxg2HJuFEWGGGAg6C8SXCXynUICUYi37C06f6td3LN\nocBrUI4dDoOVXggLVq03j+1QsfV1Eyg6F4g6AVByNvkTfcy7wnt3OVIXuoCPeHV7\ncAA/61716TWId4BtdClczEt9ISaAsV9BqFRyAiIN63geRTUWyynN13INiSJVccAC\nTixZ8ym2n96tax6KwTGL/qERhYGRA95ZzP1kdUkQi4psSYKPMDU3mHrNp0f/33wM\nX/UwYYdPCvw7/S0zgGz0//9BQlGJLFuqC/SJrbDVxdIikuT3z3cnY48Cf0wfiJLZ\nc9w9UIPWf0+WxHGcqwNYA/rwGfq4TYryfhlB9j+WsQKBgQDvGGXpc28JEty1Y2f0\nOlXgIhetpfL23O/QjrrPSXDKztiURGBOssUnavyV1qOclGh4lbxDLkpAJRZcZrTW\nknThiXC4omEkpNwkWdXZkBXCXqBoUImRX2KEcvcA47lknL2BRtXuRXnwrx4vqTc8\n5dxAjiyXKfp8NUJu6exLH4n7XwKBgQCiy4yiztpIsfWKz2OKovVyrPbFHR873MD3\nDjb8Z2ik159NbAikEezPJ867IXfCpJtjmJnIHRUV2earnhNxjWiVIah88nGYKK0t\n6X+ZpbQut/ho70o4u/VPxgsfdLEj5pxr8Df5qrpLrwu9h8Zib9XaFZ/i6p1CmVij\nIvJrETGa3QKBgDI0HEoNm/X6yO8pZU2J5jg+0Fv86WxebdiL77vQvudG0YEoblR4\nAx/Iviq0O/yHyPvw7OvqT1ryrqROSJB5hiNJWarbJaytFTBo0JdzQq5icioVJx2o\nOqZ3AVhleKsgokX/2rHCUt1v19XIITofRcUkVUaUYO0tvbpOUfhgMfffAoGACNXt\nYyTA+jMWdZs99tdTZQ74Mcib2l7n5kDSQS7HojLFxaj4axdB+BhcAxIU8u6GNIii\nyBaz/0SdXXEt8vrO01FJWMa73ZtPku9aapdwyRxZEjDyoVOqQ9Mm5WUq/BzXHpCi\nKR3YEKWGiJnm7Y7OV5DW5bUAJg42nlwWNjNvss0CgYEA5TNEEuQl+havmIL+4ISc\npwmRyRKJZpI0989demZgH6LqUrAIBhtzz1QcOKP0c4HpAd6WIKYO7sBWbgLNXlp4\n0La6eQxOtcf5Dug0/Lz1LNEO/QFheMslMveTQWL8IB3Do6LGBWaTUUMnOY9NGziV\nI4A2peuaF2/yNFXX71EYkyE=\n-----END PRIVATE KEY-----";

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

  it("Should encrypt with nested permissions", () => {
    // Get Secured Object & Encrypt
    new ActiveCrypto.Secured({}, [], {
      reference: "mockTest",
      public: pubKey,
      private: prvKey
    })
      .encrypt({
        $ADAC: [
          {
            ref: "mockTest",
            type: ActiveCrypto.ADACType.Node,
            roles: ["role1", "role2", "role3"]
          }
        ],
        data: {
          $ADAR: "role1",
          example: "default value #0",
          nestOne: {
            example: "default value #1",
            test: "results",
            nestTwo: {
              example: "default value #2",
              nestThree: {
                $ADAR: "role2",
                example: "default value #3",
                test: { hello: "world" }
              },
              nestTwoOne: {
                $ADAR: "role3",
                protected: "yes",
                images:
                  "base64:4423423423984234kml23kj4hn234iuy234879u23n423478"
              }
            }
          }
        }
      })
      .then(result => {
        encrypted = result;
        expect(result).to.be.an("object");
      });
  });

  it("Should decrypt with nested permissions", () => {
    // Get Secured Object & Encrypt
    new ActiveCrypto.Secured({}, [], {
      reference: "mockTest",
      public: pubKey,
      private: prvKey
    })
      .decrypt(encrypted)
      .then((result: any) => {
        expect(result).to.be.an("object");
        expect(result.data.nestOne.nestTwo.example).to.be.an("string");
      });
  });

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
