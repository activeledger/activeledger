import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dataSize, isDataFile } from "../packages/storage/src/selfhost-helpers";

// data_size is what the database keeps its data in on disk: not the text logs
describe("Storage data size counts the data files (Activestorage)", () => {
  it("knows a data file from the rest", () => {
    for (const name of ["000005.ldb", "000123.sst", "000027.log", "MANIFEST-000026"]) {
      expect(isDataFile(name), name).to.equal(true);
    }
    for (const name of ["LOG", "LOG.old", "CURRENT", "LOCK", "OPTIONS-000007", "notes.txt", "x.log"]) {
      expect(isDataFile(name), name).to.equal(false);
    }
  });

  it("sums the tables, the write-ahead log and the manifest, and nothing else", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-size-"));
    try {
      const put = (name: string, bytes: number) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
      put("000005.ldb", 1000);
      put("000016.ldb", 200);
      put("000027.log", 50);
      put("MANIFEST-000026", 30);
      put("LOG", 5000);
      put("LOG.old", 7000);
      put("CURRENT", 16);
      put("LOCK", 0);
      expect(await dataSize(dir)).to.equal(1280);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is zero for an empty database and does not count a folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-size-"));
    try {
      fs.mkdirSync(path.join(dir, "000009.ldb"));
      expect(await dataSize(dir)).to.be.a("number");
      expect(await dataSize(fs.mkdtempSync(path.join(dir, "e-")))).to.equal(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
