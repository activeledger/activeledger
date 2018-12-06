import { Process } from "../packages/activeprotocol/src/protocol/process";
import { expect, should } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/activecrypto/src";

describe("Process (Activeprotocol)", () => {
  // Some Random Test Data
  const random = Math.floor(Math.random() * 100000000 + 1).toString();
  let process: Process;

  it("should create process", () => {
    process = new Process(
      {
        $nodes: {
          self: {}
        },
        $tx: {
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
        $sigs: {
          testStreamId:
            "mJbmGI2VdTMC6u+/mQroEPe4unnIVtTr9W85NGsrEAi5jCG4Kt3X+yGMMYQ79wEzTyFpkcyIKHpXDfiRZLInP1BiI5ukdjI+rRNbelK0ueGLh9rHElkxm3znwxRt1ZQeXaFzUtmdLtvo1jhxxZeEa3Hs9AmvTCKWx96KJKaSaREokY3UARZZZzTKIHR5rTL4nrjd8v2g+/hWMzcm1XugjfDNqBRST8J0LYXlyvFnLOE/fc40P8JI3FKDXy/aWHS5sH9CoJDP3kYho/07Tfo4/H0jZGrJ0YQ15kc6ZUonxYRlGNpO+kpsWjhksAKVmgNMsho1nEf7d39i0Dn3aKG/Tg==",
          $sig: ""
        },
        $selfsign: true
      } as any,
      "localhost:5259",
      "self",
      {
        reference: "right",
        knock: (
          endpoint: string,
          params?: any,
          external?: boolean
        ): Promise<any> => {
          return new Promise((resolve, reject) => {});
        }
      },
      {} as any,
      {} as any,
      {} as any,
      new ActiveCrypto.Secured({}, [], {}) as any // Fix private type
    );
    expect(process).to.be.an("object");
  });
});
