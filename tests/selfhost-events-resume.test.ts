import { ActiveDSConnect } from "../packages/options/src/dsconnect";
import { expect } from "chai";
import "mocha";
import * as child from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The storage process's /events SSE feed resumes from a Last-Event-ID
 * header. selfhost.ts reads req.headers["Last-Event-ID"]; that object is
 * built by httpd from uWebSockets' req.getHeader("last-event-id"), and
 * uWebSockets matches header names case-insensitively, so the client's
 * spelling of the header must not matter. Needs the built storage package.
 */
describe("Storage /events resumes from Last-Event-ID (selfhost)", function () {
  this.timeout(30000);

  const selfhost = path.join(__dirname, "../packages/storage/lib/selfhost.js");
  let dir: string;
  let proc: child.ChildProcess;
  let port: number;

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
      srv.on("error", reject);
    });

  before(async () => {
    if (!fs.existsSync(selfhost)) {
      throw new Error(`${selfhost} missing - run npm run build first`);
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-events-resume-"));
    port = await freePort();
    // selfhost.ts prefixes "./" to its directory argument
    proc = child.spawn("node", [selfhost, ".", `${port}`, "level"], {
      cwd: dir,
      stdio: "ignore",
    });
    const events = new ActiveDSConnect(`http://127.0.0.1:${port}/activeledgerevents`);
    const deadline = Date.now() + 20000;
    for (;;) {
      if ((await events.info())?.db_name === "activeledgerevents") break;
      if (Date.now() > deadline) throw new Error("storage process did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const n of [1, 2, 3]) {
      await events.post({ _id: `event:${n}`, name: `e${n}` });
    }
  });

  after(() => {
    proc?.kill("SIGKILL");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // The ids the feed sends within `wait` ms
  const ids = (headers: http.OutgoingHttpHeaders, wait = 1000): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/activeledgerevents/events", headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          setTimeout(() => {
            req.destroy();
            resolve([...body.matchAll(/^id:(.*)$/gm)].map((m) => m[1]));
          }, wait);
        }
      );
      req.on("error", reject);
    });

  for (const header of ["Last-Event-ID", "last-event-id", "LAST-EVENT-ID"]) {
    it(`replays the events after the id, sent as ${header}`, async () => {
      expect(await ids({ [header]: "1" })).to.deep.equal(["2", "3"]);
    });
  }

  it("replays nothing without the header", async () => {
    expect(await ids({})).to.deep.equal([]);
  });
});
