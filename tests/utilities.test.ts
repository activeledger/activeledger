import { ActiveClone } from "../packages/utilities/src/clone";
import { ActiveFrame } from "../packages/utilities/src/frame";
import { expect } from "chai";
import "mocha";

// Regression coverage for two real hpe-14 perf fixes in the utilities
// package, previously only verified via one-off manual scripts.
describe("ActiveClone (Activeutilities) - hpe-14 regression (3fcfb13)", () => {
  it("round-trips a small (uncompressed) object correctly", async () => {
    const original = { hello: "world", n: 42 };
    const buf = await ActiveClone.serialize(original);
    expect(buf[0]).to.equal(0); // SerializationType.Uncompressed
    const back = await ActiveClone.deserialize(buf);
    expect(back).to.deep.equal(original);
  });

  it("round-trips a large (compressed) object correctly", async () => {
    const original = { data: "x".repeat(5000), arr: Array.from({ length: 200 }, (_, i) => i) };
    const buf = await ActiveClone.serialize(original);
    expect(buf[0]).to.equal(1); // SerializationType.Gzip
    const back = await ActiveClone.deserialize(buf);
    expect(back).to.deep.equal(original);
  });

  it("respects enableCompression: false even for large payloads", async () => {
    const original = { data: "x".repeat(5000) };
    const buf = await ActiveClone.serialize(original, { enableCompression: false });
    expect(buf[0]).to.equal(0);
    const back = await ActiveClone.deserialize(buf);
    expect(back).to.deep.equal(original);
  });

  it("still falls back to plain JSON.parse for pre-existing legacy documents", async () => {
    const legacy = Buffer.from(JSON.stringify({ old: "format", _id: "doc1" }));
    const back = await ActiveClone.deserialize(legacy);
    expect(back).to.deep.equal({ old: "format", _id: "doc1" });
  });
});

describe("ActiveFrame (Activeutilities) - hpe-14 regression (857b3e6)", () => {
  function makeFrame(payload: string): Buffer {
    const buf = Buffer.alloc(4 + payload.length);
    buf.writeUInt32BE(payload.length, 0);
    Buffer.from(payload).copy(buf, 4);
    return buf;
  }

  it("reads a single complete frame delivered in one chunk", () => {
    const frame = makeFrame("hello world");
    const result = ActiveFrame.read([frame], frame.length);
    expect(result).to.not.be.null;
    expect(result!.item.toString()).to.equal("hello world");
    expect(result!.remaining.length).to.equal(0);
    expect(result!.consumed).to.equal(frame.length);
  });

  it("reassembles a frame split across ~700 tiny chunks without re-copying the whole backlog each time", () => {
    const frame = makeFrame("x".repeat(5000));
    const chunks: Buffer[] = [];
    for (let i = 0; i < frame.length; i += 7) chunks.push(frame.slice(i, i + 7));

    let buffered: Buffer[] = [];
    let bufferLength = 0;
    let result: ReturnType<typeof ActiveFrame.read> = null;
    for (const chunk of chunks) {
      buffered.push(chunk);
      bufferLength += chunk.length;
      result = ActiveFrame.read(buffered, bufferLength);
      if (result) break;
    }
    expect(result).to.not.be.null;
    expect(result!.item.length).to.equal(5000);
    expect(result!.item.toString()).to.equal("x".repeat(5000));
  });

  it("extracts two back-to-back frames delivered in a single chunk", () => {
    const first = makeFrame("first");
    const second = makeFrame("second");
    const combined = Buffer.concat([first, second]);

    const r1 = ActiveFrame.read([combined], combined.length);
    expect(r1!.item.toString()).to.equal("first");

    const remainingChunks = r1!.remaining.length > 0 ? [r1!.remaining] : [];
    const r2 = ActiveFrame.read(remainingChunks, r1!.remaining.length);
    expect(r2!.item.toString()).to.equal("second");
  });

  it("returns null when fewer than 4 bytes are buffered (can't read the length prefix yet)", () => {
    const frame = makeFrame("hello");
    const partial = frame.slice(0, 3);
    expect(ActiveFrame.read([partial], partial.length)).to.be.null;
  });

  it("returns null when the header is present but the body isn't fully buffered yet", () => {
    const frame = makeFrame("hello world");
    const partial = frame.slice(0, 6);
    expect(ActiveFrame.read([partial], partial.length)).to.be.null;
  });
});
