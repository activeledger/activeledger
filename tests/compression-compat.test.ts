import { expect } from "chai";
import "mocha";
import { ActiveClone, COMPRESSION_THRESHOLD } from "../packages/utilities/src/clone";
// Home first, as the other network tests do: the network modules import each other in a circle
import "../packages/network/src/network/home";
import { Neighbour } from "../packages/network/src/network/neighbour";

/**
 * 5.1.8 gzips peer frames and stored documents only above 16 KB (5.1.7 gzipped
 * above 2 KB). Both builds read a body by its flag byte, never by size, so a
 * network or a database holding a mixture must still read every body. These
 * pin that in both directions.
 */
describe("compression thresholds are wire and storage compatible", () => {
  const body = (bytes: number) => ({ $umid: "u", pad: Array.from({ length: bytes / 8 }, (_, i) => `k${i}`.padEnd(8, "x")).join("") });
  const FLAG_PLAIN = 0x00;
  const FLAG_GZIP = 0x01;

  it("the old 2 KB threshold is unchanged as the default for everything else", () => {
    expect(COMPRESSION_THRESHOLD).to.equal(2048);
  });

  it("reads a 5 KB body gzipped under the old threshold and plain under the new, to the same value", async () => {
    const value = body(5000);
    const old = await ActiveClone.serialize(value, { enableCompression: true });
    const next = await ActiveClone.serialize(value, { enableCompression: true, compressionThreshold: 16 * 1024 });
    expect(old[0]).to.equal(FLAG_GZIP);
    expect(next[0]).to.equal(FLAG_PLAIN);
    expect(await ActiveClone.deserialize(old)).to.deep.equal(value);
    expect(await ActiveClone.deserialize(next)).to.deep.equal(value);
  });

  it("still gzips a body over the new threshold, and reads it", async () => {
    const value = body(40000);
    const buf = await ActiveClone.serialize(value, { enableCompression: true, compressionThreshold: 16 * 1024 });
    expect(buf[0]).to.equal(FLAG_GZIP);
    expect(await ActiveClone.deserialize(buf)).to.deep.equal(value);
  });

  it("a peer frame from this build reads with the plain deserializer a 5.1.7 node uses", async () => {
    for (const size of [500, 5000, 20000, 60000]) {
      const value = body(size);
      const frame = await Neighbour.serialiseParams(value);
      expect([FLAG_PLAIN, FLAG_GZIP]).to.include(frame[0]);
      expect(await ActiveClone.deserialize(frame)).to.deep.equal(value);
    }
  });

  it("only compresses a peer frame once it passes 16 KB", async () => {
    expect((await Neighbour.serialiseParams(body(5000)))[0]).to.equal(FLAG_PLAIN);
    expect((await Neighbour.serialiseParams(body(30000)))[0]).to.equal(FLAG_GZIP);
  });
});
