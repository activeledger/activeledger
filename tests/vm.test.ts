import { IActiveDSConnect } from "../packages/definitions/lib/definitions";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect, should } from "chai";
import "mocha";

describe("Virtual Machine Test (Activeprotocol)", () => {
  // Some Random Test Data
  const random = Math.floor(Math.random() * 100000000 + 1);

  let VM: VirtualMachine;

  it("should create secured VM", () => {
    VM = new VirtualMachine(
      "localhost:5259",
      new ActiveCrypto.Secured({} as IActiveDSConnect, [], {}) as any, // Fix private type
      {} as any,
      {} as any
    );
    expect(VM).to.be.an("object");
  });

  it("should initalise VM contract as promised", () => {
    expect(
      VM.initialise(
        {
          contractLocation: "./test/",
          umid: "test",
          date: new Date(),
          remoteAddress: "localhost",
          transaction: {
            $namespace: "test",
            $contract: "test",
            $i: {},
            $o: {}
          },
          signatures: {
            testStreamId:
              "mJbmGI2VdTMC6u+/mQroEPe4unnIVtTr9W85NGsrEAi5jCG4Kt3X+yGMMYQ79wEzTyFpkcyIKHpXDfiRZLInP1BiI5ukdjI+rRNbelK0ueGLh9rHElkxm3znwxRt1ZQeXaFzUtmdLtvo1jhxxZeEa3Hs9AmvTCKWx96KJKaSaREokY3UARZZZzTKIHR5rTL4nrjd8v2g+/hWMzcm1XugjfDNqBRST8J0LYXlyvFnLOE/fc40P8JI3FKDXy/aWHS5sH9CoJDP3kYho/07Tfo4/H0jZGrJ0YQ15kc6ZUonxYRlGNpO+kpsWjhksAKVmgNMsho1nEf7d39i0Dn3aKG/Tg==",
            $sig: ""
          },
          inputs: [],
          outputs: [],
          readonly: {},
          key: random
        },
        "test"
      )
    ).to.be.a("promise");
  });

  it("should run smart contract verify as promised", () => {
    expect(VM.verify(true, "test")).to.be.a("promise");
  });

  it("should run smart contract vote as promised", () => {
    expect(VM.vote("test")).to.be.a("promise");
  });

  it("should run smart contract commit as promised", () => {
    expect(VM.commit({} as any, false, "test")).to.be.a("promise");
  });

  it("should get transaction inputs from VM", () => {
    expect(VM.getInputs("test"))
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
