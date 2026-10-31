import { expect } from "chai";
import "mocha";
import * as child from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EPIDChild,
  PIDHandler,
} from "../packages/activeledger/src/cli/pid";

// The PID file is ".PID" in the working directory, so each test runs inside
// its own temporary directory and the original directory is restored after.
describe("PIDHandler (activeledger pid file)", () => {
  const startDir = process.cwd();
  let tmpDir: string;
  let handler: PIDHandler;

  const onDisk = () => JSON.parse(fs.readFileSync(".PID", "utf8"));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-pid-test-"));
    process.chdir(tmpDir);
    handler = new PIDHandler();
  });

  afterEach(() => {
    process.chdir(startDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates the file with every pid at zero when it is missing", async () => {
      await handler.init();
      expect(onDisk()).to.deep.equal({
        activeledger: 0,
        activestorage: 0,
        activerestore: 0,
      });
    });

    it("leaves an existing file alone", async () => {
      fs.writeFileSync(
        ".PID",
        JSON.stringify({ activeledger: 7, activestorage: 8, activerestore: 9 })
      );
      await handler.init();
      expect(onDisk()).to.deep.equal({
        activeledger: 7,
        activestorage: 8,
        activerestore: 9,
      });
    });
  });

  describe("reading", () => {
    it("returns all pids", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.LEDGER, 11);
      expect(await handler.getPids()).to.deep.equal({
        activeledger: 11,
        activestorage: 0,
        activerestore: 0,
      });
    });

    it("throws when the file cannot be read", async () => {
      // Never initialised, so there is no file
      let thrown: any;
      try {
        await handler.getPids();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.an("error");
      expect(thrown.code).to.equal("ENOENT");
    });

    it("throws when the file is not valid json", async () => {
      fs.writeFileSync(".PID", "{not json");
      let thrown: any;
      try {
        await handler.getPids();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(SyntaxError);
    });

    it("returns the pid for each child", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.LEDGER, 11);
      await handler.addPid(EPIDChild.STORAGE, 22);
      await handler.addPid(EPIDChild.RESTORE, 33);
      expect(await handler.getPID(EPIDChild.LEDGER)).to.equal(11);
      expect(await handler.getPID(EPIDChild.STORAGE)).to.equal(22);
      expect(await handler.getPID(EPIDChild.RESTORE)).to.equal(33);
    });

    it("names the child in the error when its pid is not set", async () => {
      await handler.init();
      const fail = async (c: EPIDChild) => {
        try {
          await handler.getPID(c);
        } catch (e) {
          return e.message;
        }
        return "no error";
      };
      expect(await fail(EPIDChild.LEDGER)).to.equal(
        "Error finding Activeledger PID"
      );
      expect(await fail(EPIDChild.STORAGE)).to.equal(
        "Error finding Activestorage PID"
      );
      expect(await fail(EPIDChild.RESTORE)).to.equal(
        "Error finding Activerestore PID"
      );
    });

    it("rejects a child it does not know", async () => {
      await handler.init();
      let thrown: any;
      try {
        await handler.getPID("activecore" as EPIDChild);
      } catch (e) {
        thrown = e;
      }
      expect(thrown.message).to.equal("Unkown PID requested");
    });

    it("passes the read error through getPID", async () => {
      let thrown: any;
      try {
        await handler.getPID(EPIDChild.LEDGER);
      } catch (e) {
        thrown = e;
      }
      expect(thrown.code).to.equal("ENOENT");
    });
  });

  describe("writing", () => {
    it("adds a pid without disturbing the others", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.STORAGE, 22);
      await handler.addPid(EPIDChild.LEDGER, 11);
      expect(onDisk()).to.deep.equal({
        activeledger: 11,
        activestorage: 22,
        activerestore: 0,
      });
    });

    it("keeps keys it does not manage, such as the old activecore pid", async () => {
      fs.writeFileSync(
        ".PID",
        JSON.stringify({
          activeledger: 1,
          activestorage: 2,
          activecore: 3,
          activerestore: 4,
        })
      );
      await handler.addPid(EPIDChild.LEDGER, 10);
      expect(onDisk()).to.deep.equal({
        activeledger: 10,
        activestorage: 2,
        activecore: 3,
        activerestore: 4,
      });
    });

    it("removes a pid by setting it to zero", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.RESTORE, 33);
      await handler.removePid(EPIDChild.RESTORE);
      expect(onDisk().activerestore).to.equal(0);
      let thrown: any;
      try {
        await handler.getPID(EPIDChild.RESTORE);
      } catch (e) {
        thrown = e;
      }
      expect(thrown.message).to.equal("Error finding Activerestore PID");
    });

    it("resets every pid", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.LEDGER, 11);
      await handler.addPid(EPIDChild.STORAGE, 22);
      await handler.resetPidFile();
      expect(onDisk()).to.deep.equal({
        activeledger: 0,
        activestorage: 0,
        activerestore: 0,
      });
    });
  });

  describe("getStatus", () => {
    it("is true when the ledger pid belongs to a running process", async () => {
      await handler.init();
      await handler.addPid(EPIDChild.LEDGER, process.pid);
      expect(await handler.getStatus()).to.equal(true);
    });

    it("is false when no ledger pid is recorded", async () => {
      await handler.init();
      expect(await handler.getStatus()).to.equal(false);
    });

    it("is false when the recorded process has exited", async () => {
      // A process that has run and been reaped, so its pid is not alive
      const done = child.spawnSync(process.execPath, ["-e", "0"]);
      await handler.init();
      await handler.addPid(EPIDChild.LEDGER, done.pid);
      expect(await handler.getStatus()).to.equal(false);
    });

    it("is false when there is no pid file", async () => {
      expect(await handler.getStatus()).to.equal(false);
    });
  });
});
