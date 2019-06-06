import { ActiveLogger } from "../packages/logger/src";
import { ActiveCrypto } from "../packages/crypto/src";

// Setup VM Global variables
((global as unknown) as any).crypto = ActiveCrypto;
((global as unknown) as any).logger = ActiveLogger;

import { Stream } from "../packages/contracts/src";
import { expect, should } from "chai";
import "mocha";

describe("Stream Management Test (Activecontracts)", () => {
  // Security Key
  const key = Math.floor(Math.random() * 10000 + 1);

  // Predefined Stream
  const activeledgerStream = new Stream(
    new Date(),
    "::1",
    "umid",
    {
      $namespace: "default",
      $contract: "onboard",
      $i: {
        testStreamId: {
          publicKey:
            "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwUYrUdC11Y+0vH8JD7FC\nlVXTnStllicQ1PPgbrsftuxWJFqE1FPa6qwwdo6y0ZjQTmwsPUSTzLiX5Kr1UVdY\nFZVP/DDeWafOwh80vMZpBuUcxl4hh6IEXf8BtKelwUIq1gmwR2QS6LPjG9UeblBg\nq6a0h3Z1LAB/Ls9+78Rs9zuSwKYBdvn1IT6jwOkQ2eZj+8JO0vDr6VYUzenu+HAG\nuzq+ioHaS9uVn3Vlo7p5FjkXdI0g8rkC8kiwh+dW4d4Qdep0nRSjCUhpYpQhifjp\nHLM/Mtpkbc0gGgUu7NSuHkNBYUbl9TAOQkZNaU1rgYWt0gZ3jMQuttOCfF55We72\niwIDAQAB\n-----END PUBLIC KEY-----"
        }
      },
      $o: {}
    },
    [
      {
        meta: {
          _id: "testStreamId",
          _rev: null
        },
        state: { _id: "testStreamId", _rev: null },
        volatile: {}
      }
    ],
    [],
    [],
    {
      testStreamId:
        "mJbmGI2VdTMC6u+/mQroEPe4unnIVtTr9W85NGsrEAi5jCG4Kt3X+yGMMYQ79wEzTyFpkcyIKHpXDfiRZLInP1BiI5ukdjI+rRNbelK0ueGLh9rHElkxm3znwxRt1ZQeXaFzUtmdLtvo1jhxxZeEa3Hs9AmvTCKWx96KJKaSaREokY3UARZZZzTKIHR5rTL4nrjd8v2g+/hWMzcm1XugjfDNqBRST8J0LYXlyvFnLOE/fc40P8JI3FKDXy/aWHS5sH9CoJDP3kYho/07Tfo4/H0jZGrJ0YQ15kc6ZUonxYRlGNpO+kpsWjhksAKVmgNMsho1nEf7d39i0Dn3aKG/Tg==",
      $sig: ""
    },
    key,
    "localhost"
  );

  it("should create a new stream", () => {
    expect(activeledgerStream)
      .to.be.an("object")
      .and.property("umid", "umid");
  });

  it("should have a matching signature", () => {
    expect(activeledgerStream.getActivityStreams("testStreamId").hasSignature())
      .to.be.an("boolean")
      .equals(true);
  });

  it("should have a not have enough signature", () => {
    expect(activeledgerStream.getMofSignatures(3))
      .to.be.an("boolean")
      .equals(false);
  });

  it("should have no read only streams", () => {
    expect(activeledgerStream.getReadOnlyStream("na"))
      .to.be.an("boolean")
      .equals(false);
  });

  it("should be executing on localhost", () => {
    expect(activeledgerStream.isExecutingOn("localhost"))
      .to.be.an("boolean")
      .equals(true);
  });

  it("should not have timeout set", () => {
    expect(activeledgerStream.getTimeout()).to.be.undefined;
  });

  it("should have an array with location to throw transaction to", () => {
    activeledgerStream.throw("localhost:1234");
    expect(activeledgerStream.throwTo)
      .to.be.an("array")
      .and.to.has.property("0", "localhost:1234");
  });

  it("should create a new activity", () => {
    expect(activeledgerStream.newActivityStream("test.new"))
      .to.be.an("object")
      .and.property("key", key);
  });

  it("should create a new deterministic activity", () => {
    // Determined Value
    const streamId = ActiveCrypto.Hash.getHash(
      `deterministic.${key}` + "test.new",
      "sha256"
    );

    // Test Activity Created Correctly
    expect(
      activeledgerStream.newActivityStream("test.new", `deterministic.${key}`)
    )
      .to.be.an("object")
      .to.have.property("state")
      .that.is.an("object")
      .that.eql({ _id: streamId, _rev: null });
  });

  it("should export activities to the ledger", () => {
    const exportTest = activeledgerStream
      .newActivityStream("test.export")
      .export2Ledger(key);
    expect(exportTest).to.have.property("state");
    expect(exportTest).to.have.property("meta");
    expect(exportTest).to.have.property("volatile");
  });

  it("should FAIL to export activities to the ledger", () => {
    const activity = activeledgerStream.newActivityStream("test.export");
    activity.setKey(0);
    should().throw(() => {
      activity.export2Ledger(key);
    });
  });

  it("activity should have a name or id", () => {
    expect(activeledgerStream.newActivityStream("test.new").getId()).to.be.an(
      "string"
    );
  });

  it("activity should a deterministic number generator", () => {
    expect(activeledgerStream.newActivityStream("test.new").getCng()).to.be.an(
      "number"
    );
  });

  it("activity should have no authority", () => {
    expect(activeledgerStream.getActivityStreams("testStreamId").getAuthority())
      .to.be.undefined;
  });
});
