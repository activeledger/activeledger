import { IActiveDSConnect } from "../packages/definitions/lib/definitions";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect, should } from "chai";
import "mocha";

describe("Virtual Machine Test (Activeprotocol)", () => {
  // Some Random Test Data
  const random = Math.floor(Math.random() * 100000000 + 1).toString();

  let VM: VirtualMachine;

  it("should create secured VM", () => {
    VM = new VirtualMachine(
      "",
      "localhost:5259",
      "",
      new Date(),
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
      {
        testStreamId:
          "mJbmGI2VdTMC6u+/mQroEPe4unnIVtTr9W85NGsrEAi5jCG4Kt3X+yGMMYQ79wEzTyFpkcyIKHpXDfiRZLInP1BiI5ukdjI+rRNbelK0ueGLh9rHElkxm3znwxRt1ZQeXaFzUtmdLtvo1jhxxZeEa3Hs9AmvTCKWx96KJKaSaREokY3UARZZZzTKIHR5rTL4nrjd8v2g+/hWMzcm1XugjfDNqBRST8J0LYXlyvFnLOE/fc40P8JI3FKDXy/aWHS5sH9CoJDP3kYho/07Tfo4/H0jZGrJ0YQ15kc6ZUonxYRlGNpO+kpsWjhksAKVmgNMsho1nEf7d39i0Dn3aKG/Tg==",
        $sig: ""
      },
      [],
      [],
      [],
      {} as any,
      {} as any,
      new ActiveCrypto.Secured({} as IActiveDSConnect, [], {}) as any // Fix private type
    );
    expect(VM).to.be.an("object");
  });

  it("should initalise VM contract as promised", () => {
    expect(VM.initalise()).to.be.a("promise");
  });

  it("should run smart contract verify as promised", () => {
    expect(VM.verify(true)).to.be.a("promise");
  });

  it("should run smart contract vote as promised", () => {
    expect(VM.vote()).to.be.a("promise");
  });

  it("should run smart contract commit as promised", () => {
    expect(VM.commit({} as any, false)).to.be.a("promise");
  });

  it("should get transaction inputs from VM", () => {
    expect(VM.getInputs())
      .to.be.an("array")
      .length(0);
  });

  it("should get error as no valid contract loaded to retrieve from", () => {
    // Transaction
    should().throw(() => {
      VM.getThrowsFromVM();
    });

    // Activity Streams
    should().throw(() => {
      VM.getActivityStreamsFromVM();
    });

    // Node Comms
    should().throw(() => {
      VM.getInternodeCommsFromVM();
    });

    // Prevent timeout checks
    (VM as any).scriptFinishedExec = true;
  });
});
