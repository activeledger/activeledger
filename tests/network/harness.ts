/**
 * Bare-host multi-node network harness for the live integration test
 * (tests/network/run.ts). Boots N real activeledger node processes on the
 * local machine, following the manual procedure documented in cli.md
 * (--setup-only per instance, --merge to stitch neighbourhoods together,
 * then start each node for real) - reused throughout hpe-13/hpe-14's own
 * live testing, now made reusable and reliable instead of one-off shell
 * commands.
 *
 * Deliberately bare-host, not Docker - no additional requirements for a
 * developer running this beyond what's already needed to build the repo.
 */

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";

const LEDGER_ENTRY = path.resolve(
  __dirname,
  "../../packages/activeledger/lib/index.js"
);

export interface NetworkNode {
  index: number;
  port: number;
  storagePort: number;
  dataDir: string;
  baseUrl: string;
  storageUrl: string;
  child: ChildProcess;
  logPath: string;
}

export interface NetworkHarnessOptions {
  nodeCount?: number;
  basePort?: number;
  portSpacing?: number;
  readyTimeoutMs?: number;
}

const DEFAULTS: Required<NetworkHarnessOptions> = {
  nodeCount: 4,
  // Not the literal default (5260) - see cli.md's --port gotcha, a
  // non-default port keeps every instance's autostart behaviour identical
  // and avoids colliding with anything a developer might already have
  // running locally.
  basePort: 5510,
  portSpacing: 10,
  readyTimeoutMs: 20000,
};

function runOnce(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LEDGER_ENTRY, ...args], {
      cwd,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

/**
 * `activeledger --stop` does its actual job (killing the tracked
 * activeledger/activestorage/activecore/activerestore PIDs) but then never
 * calls process.exit() itself, unlike --backup/--restore - confirmed as a
 * real, standalone bug (reproduced directly outside this harness, not an
 * artifact of how this harness spawns it). Don't wait for its own exit;
 * give it a short window to do its work, then kill it regardless.
 */
function runStop(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LEDGER_ENTRY, "--stop"], {
      cwd,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 3000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function httpGetJson(url: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send anything - just checks the pid exists
    // and is signalable by this user.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collects every descendant PID of `rootPid` via /proc (Linux
 * only, matches this environment). Needed because a node forks a whole
 * worker pool (network/process.js, one per CPU core plus a standby - see
 * network-internals.md) that survives a direct kill of just the main
 * process: Node doesn't kill children automatically on a parent's exit,
 * and these workers aren't tracked in the .PID file the way
 * activestorage/activecore/activerestore are - confirmed directly (ps aux
 * still showed a full set of network/process.js instances after --stop
 * completed and the main process had already exited). This is the same
 * gap documented in cli.md's --stop section; harmless for a human running
 * --stop once, but a test harness that boots and tears down repeatedly
 * needs to actually not leak these.
 */
function collectDescendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    try {
      const childrenPath = `/proc/${pid}/task/${pid}/children`;
      const raw = fs.readFileSync(childrenPath, "utf8").trim();
      if (!raw) continue;
      const children = raw.split(/\s+/).map(Number).filter((n) => !isNaN(n));
      for (const child of children) {
        descendants.push(child);
        stack.push(child);
      }
    } catch {
      // /proc not available, or the process already exited - nothing more
      // to find down this branch.
    }
  }
  return descendants;
}

export class NetworkHarness {
  public nodes: NetworkNode[] = [];
  private opts: Required<NetworkHarnessOptions>;
  private rootDir: string;

  constructor(options: NetworkHarnessOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "activeledger-network-test-")
    );
  }

  /**
   * Runs --setup-only for every instance, merges their neighbourhoods
   * together, then starts every node for real and waits until each
   * reports status:4 (a settled view of its ring neighbours).
   */
  public async start(): Promise<NetworkNode[]> {
    const { nodeCount, basePort, portSpacing } = this.opts;

    const dataDirs: string[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const dataDir = path.join(this.rootDir, `instance-${i}`);
      fs.mkdirSync(dataDir, { recursive: true });
      dataDirs.push(dataDir);
    }

    // --setup-only for every instance in parallel - each just writes its
    // own config.json/.identity, no network involved yet.
    await Promise.all(
      dataDirs.map((dataDir, i) =>
        runOnce(
          ["--setup-only", "--port", String(basePort + i * portSpacing), "--data-dir", ".ds"],
          dataDir
        )
      )
    );

    // Stitch every instance's neighbourhood together into one list, written
    // back into every config.json.
    await runOnce(
      dataDirs.flatMap((dataDir) => ["--merge", path.join(dataDir, "config.json")]),
      this.rootDir
    );

    // Start every node for real.
    this.nodes = dataDirs.map((dataDir, i) => {
      const port = basePort + i * portSpacing;
      const logPath = path.join(dataDir, "node.log");
      const logFd = fs.openSync(logPath, "a");
      const child = spawn(process.execPath, [LEDGER_ENTRY, "--port", String(port)], {
        cwd: dataDir,
        stdio: ["ignore", logFd, logFd],
      });
      return {
        index: i,
        port,
        storagePort: port - 1,
        dataDir,
        baseUrl: `http://127.0.0.1:${port}`,
        storageUrl: `http://127.0.0.1:${port - 1}`,
        child,
        logPath,
      };
    });

    await this.waitUntilReady();
    return this.nodes;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    const pending = new Set(this.nodes.map((n) => n.index));

    while (pending.size > 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for nodes to become ready: ${[...pending].join(", ")}`
        );
      }
      for (const node of this.nodes) {
        if (!pending.has(node.index)) continue;
        if (node.child.exitCode !== null) {
          throw new Error(
            `Node ${node.index} exited early (code ${node.child.exitCode}) - see ${node.logPath}`
          );
        }
        try {
          const status = await httpGetJson(`${node.baseUrl}/a/status`);
          if (status.status === 4) {
            pending.delete(node.index);
          }
        } catch {
          // Not up yet, try again next tick
        }
      }
      if (pending.size > 0) {
        await sleep(300);
      }
    }
  }

  /**
   * Stop every node via `activeledger --stop`, not a raw SIGTERM to the
   * child handle - a node forks a separate storage subprocess
   * (selfhost.js) that survives a direct kill of just the main process
   * (its own SIGTERM handler is a bare process.exit(), which doesn't cascade
   * to children Node didn't fork itself - see cli.md's --stop gotcha).
   * `--stop` reads each instance's own .PID file (main process +
   * activestorage, written directly by datastore.ts's storePid() - plus
   * activecore/activerestore if running) and kills all of them. Also not a
   * pattern-matched pkill, which repeatedly proved unreliable during
   * hpe-13/hpe-14's manual testing (command lines don't include any
   * distinguishing scratch-dir name, so loose patterns miss processes or
   * catch unrelated ones).
   */
  public async stop(): Promise<void> {
    // Capture the worker pool's PIDs before touching anything - once the
    // main process exits, its /proc entry (and the parent/child
    // relationship recorded there) disappears, so this only works if done
    // first.
    const workerPids = this.nodes.flatMap((node) =>
      node.child.pid ? collectDescendantPids(node.child.pid) : []
    );

    await Promise.all(
      this.nodes.map(async (node) => {
        if (node.child.exitCode === null && !node.child.killed) {
          await runStop(node.dataDir);
        }

        await new Promise<void>((resolve) => {
          if (node.child.exitCode !== null || node.child.killed) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            // --stop didn't take within a reasonable window - force it.
            try {
              node.child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, 5000);
          node.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      })
    );

    // The storage subprocess doesn't share a parent/child relationship
    // with anything we hold a handle to, so double check nothing with this
    // run's exact data directory is still alive and clean it up directly
    // if --stop somehow missed it.
    for (const node of this.nodes) {
      try {
        const pidPath = path.join(node.dataDir, ".PID");
        const pidData = JSON.parse(fs.readFileSync(pidPath, "utf8"));
        for (const key of ["activeledger", "activestorage", "activecore", "activerestore"]) {
          const pid = pidData[key];
          if (pid && pid !== 0 && isProcessAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
      } catch {
        // No .PID file, or already cleaned up - nothing to do.
      }
    }

    // Finally, the worker pool captured above - these are never tracked
    // anywhere on disk, so this PID list captured before teardown started
    // is the only record of them.
    for (const pid of workerPids) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }

  public cleanup(): void {
    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }
}
