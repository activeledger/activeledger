import { expect } from "chai";
import "mocha";
import {
  isValidDbName,
  checkDoc,
  prepareAllDocs,
  filterPrefix,
} from "../packages/storage/src/selfhost-helpers";

describe("selfhost-helpers isValidDbName", () => {
  it("accepts the base name and suffixed names", () => {
    expect(isValidDbName("activeledger")).to.equal(true);
    expect(isValidDbName("activeledgerevents")).to.equal(true);
    expect(isValidDbName("activeledger_a-B-9")).to.equal(true);
  });

  it("accepts a suffix of exactly 64 characters and rejects 65", () => {
    expect(isValidDbName("activeledger" + "a".repeat(64))).to.equal(true);
    expect(isValidDbName("activeledger" + "a".repeat(65))).to.equal(false);
  });

  it("rejects names without the prefix", () => {
    expect(isValidDbName("")).to.equal(false);
    expect(isValidDbName("other")).to.equal(false);
    expect(isValidDbName("Activeledger")).to.equal(false);
    expect(isValidDbName("xactiveledger")).to.equal(false);
  });

  it("rejects path traversal and separators", () => {
    expect(isValidDbName("activeledger/../etc")).to.equal(false);
    expect(isValidDbName("activeledger..")).to.equal(false);
    expect(isValidDbName("activeledger\\x")).to.equal(false);
    expect(isValidDbName("activeledger/x")).to.equal(false);
    expect(isValidDbName("../activeledger")).to.equal(false);
  });

  it("rejects trailing newline and other whitespace", () => {
    expect(isValidDbName("activeledger\n")).to.equal(false);
    expect(isValidDbName("activeledger x")).to.equal(false);
  });
});

describe("selfhost-helpers checkDoc", () => {
  it("adds a generated _id when missing", () => {
    const doc: any = { a: 1 };
    const out = checkDoc(doc);
    expect(out).to.equal(doc);
    expect(out._id).to.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("generates distinct ids", () => {
    expect(checkDoc({})._id).to.not.equal(checkDoc({})._id);
  });

  it("keeps an existing _id", () => {
    expect(checkDoc({ _id: "mine" })._id).to.equal("mine");
  });
});

describe("selfhost-helpers filterPrefix", () => {
  const long = "a".repeat(70);

  it("returns a plain id unchanged", () => {
    expect(filterPrefix("abc")).to.equal("abc");
  });

  it("keeps a suffix", () => {
    expect(filterPrefix("abc:volatile")).to.equal("abc:volatile");
    expect(filterPrefix("abc:umid")).to.equal("abc:umid");
  });

  it("trims ids longer than 64 characters to their last 64", () => {
    const id = "x".repeat(6) + "b".repeat(64);
    expect(filterPrefix(id)).to.equal("b".repeat(64));
  });

  it("trims the id but keeps the suffix", () => {
    expect(filterPrefix(long + ":stream")).to.equal(long.slice(-64) + ":stream");
  });

  it("does not trim 0x ids", () => {
    const id = "0x" + "f".repeat(70);
    expect(filterPrefix(id)).to.equal(id);
  });

  it("leaves a 64 character id alone", () => {
    const id = "c".repeat(64);
    expect(filterPrefix(id)).to.equal(id);
  });

  it("only filters the activeledger database", () => {
    expect(filterPrefix(long, "activeledgerevents")).to.equal(long);
    expect(filterPrefix(long, "activeledger")).to.equal(long.slice(-64));
  });
});

describe("selfhost-helpers prepareAllDocs", () => {
  it("parses limit to a number, or null when not numeric", () => {
    expect(prepareAllDocs({ limit: "25" }).limit).to.equal(25);
    expect(prepareAllDocs({ limit: "abc" }).limit).to.equal(null);
  });

  it("strips quotes from startkey", () => {
    expect(prepareAllDocs({ startkey: '"abc"' }).startkey).to.equal("abc");
  });

  it("strips quotes from endkey and replaces its last character with the unicode high marker", () => {
    expect(prepareAllDocs({ endkey: '"abc"' }).endkey).to.equal("ab香");
  });

  it("filters prefixes on keys", () => {
    const out = prepareAllDocs({ keys: ["a".repeat(70), "b:umid"] });
    expect(out.keys).to.deep.equal(["a".repeat(64), "b:umid"]);
  });

  it("leaves absent options absent", () => {
    expect(prepareAllDocs({})).to.deep.equal({});
  });
});
