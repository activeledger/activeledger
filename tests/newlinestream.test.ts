import { newLineTransform } from "../packages/storage/src/newlinestream";
import { expect } from "chai";
import "mocha";

// Regression coverage for the next-perf fix (38051bb): newLineTransform()
// switched from _last.split(/\n/) to _last.split("\n") - a plain string
// split is behaviorally identical to a single-char-literal regex split,
// just without invoking the regex engine. No prior test coverage existed
// for this module at all.
describe("newLineTransform (Activestorage) - next-perf regression", () => {
  function collect(chunks: (string | Buffer)[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = newLineTransform();
      const lines: string[] = [];
      stream.on("data", (line: Buffer) => lines.push(line.toString()));
      stream.on("end", () => resolve(lines));
      stream.on("error", reject);
      for (const chunk of chunks) {
        stream.write(chunk);
      }
      stream.end();
    });
  }

  it("splits a single chunk containing several lines", async () => {
    const lines = await collect(["one\ntwo\nthree\n"]);
    expect(lines).to.deep.equal(["one", "two", "three"]);
  });

  it("buffers a partial final line until flush", async () => {
    const lines = await collect(["one\ntwo\nthree"]);
    expect(lines).to.deep.equal(["one", "two", "three"]);
  });

  it("reassembles a line split across multiple chunks", async () => {
    const lines = await collect(["fo", "o\nb", "ar\n"]);
    expect(lines).to.deep.equal(["foo", "bar"]);
  });

  it("silently drops an empty line between two real lines (non-object-mode push(\"\") is a no-op)", async () => {
    // The transform does call this.push("") for the middle segment of
    // "one\n\ntwo\n" - but this stream isn't in objectMode, and Node
    // treats pushing a zero-length chunk in buffer mode as a no-op (same
    // as push(Buffer.alloc(0))), so no corresponding "data" event fires
    // for it. Pre-existing stream behavior, unrelated to the
    // split(/\n/) -> split("\n") fix this file covers.
    const lines = await collect(["one\n\ntwo\n"]);
    expect(lines).to.deep.equal(["one", "two"]);
  });

  it("pushes the literal string \"undefined\" for a stream with no input at all (pre-existing quirk, not introduced by this fix)", async () => {
    // _last is only initialised to "" inside transform() - with zero
    // chunks written, transform() never runs, so flush()'s
    // `_last += decoder.end()` coerces `undefined + ""` to the string
    // "undefined", which is truthy and gets pushed. Documenting the
    // actual current behavior rather than asserting what it "should" be -
    // unrelated to the split(/\n/) -> split("\n") fix this file covers.
    const lines = await collect([]);
    expect(lines).to.deep.equal(["undefined"]);
  });

  it("handles Buffer chunks the same as string chunks", async () => {
    const lines = await collect([Buffer.from("alpha\nbeta\n")]);
    expect(lines).to.deep.equal(["alpha", "beta"]);
  });
});
