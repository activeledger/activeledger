/**
 * Live check of `activeledger project` on a real 4-node network, in a real git repository:
 * init, a new identity onboarded, deploy (namespace + contract), an example transaction, a second
 * deploy that must do nothing, a taken namespace refused, and the key file kept out of git.
 *
 *   npx tsx tests/network/project-live.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { withNetwork } from "../stress/lib/workload";
import { defaultDeps, projectCommand, ProjectFlags } from "../../packages/activeledger/src/project/commands";

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const git = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

async function main(): Promise<number> {
  await withNetwork({ nodeCount: 4, basePort: 5770, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const urls = nodes.map((n) => n.baseUrl);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-live-"));
    const logs: string[] = [];
    const errs: string[] = [];
    const out = { log: (t: string) => logs.push(t), error: (t: string) => errs.push(t) };
    const run = (pos: string[], flags: ProjectFlags = {}, dir = root, env: any = {}) =>
      projectCommand(pos, { noAudit: true, ...flags }, { ...defaultDeps(out), cwd: dir, env: { ...process.env, ...env }, tty: false });

    try {
      git(root, "init", "-q");
      check((await run(["init"], { name: "projlive", net: [`testnet=${urls.join(",")}`] })) === 0, "init");
      check(git(root, "check-ignore", "-q", ".activeledger-key").status === 0, "the key file is ignored by git after init");

      check((await run(["identity", "new", "alice"])) === 0, `identity new alice onboarded (${errs.join(" ").slice(0, 120)})`);
      logs.length = 0;
      await run(["identity", "list"]);
      check(logs.join("\n").includes("testnet:") && !logs.join("\n").includes("PRIVATE"), "identity list shows the stream id and no key");

      // A contract and an example, written as a person would
      fs.copyFileSync(path.join(__dirname, "contracts/returner-contract.ts"), path.join(root, "returner.ts"));
      const file = path.join(root, ".activeledger");
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      p.contracts.returner = { source: "returner.ts", version: "0.0.1" };
      p.transactions.say = { contract: "returner", input: { "@alice": {} }, output: { "@alice": { message: "hello from the project" } }, expect: { commit: 1 } };
      fs.writeFileSync(file, JSON.stringify(p, null, 2));

      logs.length = 0;
      const deployed = await run(["deploy"]);
      check(deployed === 0, `deploy registered the namespace and uploaded the contract (${logs.concat(errs).join(" | ").slice(0, 300)})`);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      check(after.networks.testnet.namespaceRegistered === true && /^[0-9a-f]{64}$/.test((after.networks.testnet.contracts?.returner || {}).id || ""), "the namespace and the contract's stream id are recorded in the project file");

      logs.length = 0;
      check((await run(["tx", "run", "say"])) === 0, `tx run say committed (${logs.concat(errs).join(" | ").slice(0, 300)})`);

      logs.length = 0;
      check((await run(["deploy"])) === 0 && /already current/.test(logs.join("\n")) && /already registered/.test(logs.join("\n")), "a second deploy does nothing");

      // Change the source: needs a new version, then updates
      fs.writeFileSync(path.join(root, "returner.ts"), fs.readFileSync(path.join(root, "returner.ts"), "utf8") + "\n// a change\n");
      logs.length = 0;
      check((await run(["contract", "update", "returner"])) === 1 && /bump/.test(logs.join("\n")), "a changed source with the same version is told to bump it");
      const q = JSON.parse(fs.readFileSync(file, "utf8"));
      q.contracts.returner.version = "0.0.2";
      fs.writeFileSync(file, JSON.stringify(q, null, 2));
      logs.length = 0;
      check((await run(["contract", "update", "returner"])) === 0, `contract update to 0.0.2 (${logs.concat(errs).join(" | ").slice(0, 300)})`);
      check((await run(["tx", "run", "say"], { set: ["output.@alice.message=after the update"] })) === 0, "the example runs after the update");

      // The same namespace from another project is refused
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "project-live-other-"));
      git(other, "init", "-q");
      await run(["init"], { name: "projlive", net: [`testnet=${urls[0]}`] }, other);
      await run(["identity", "new", "mallory"], {}, other);
      logs.length = 0;
      const taken = await run(["namespace", "register"], {}, other);
      check(taken === 1 && /taken/.test(logs.join("\n")), "the namespace is refused to a second project");
      fs.rmSync(other, { recursive: true, force: true });

      // Nothing secret reaches git
      git(root, "add", "-A");
      const staged = git(root, "ls-files").stdout;
      check(staged.includes(".activeledger\n") && !staged.includes(".activeledger-key"), "git add -A adds the project file and not the key file");
      check(!fs.readFileSync(file, "utf8").includes("PRIVATE KEY"), "the project file holds no key");

      // Status
      logs.length = 0;
      check((await run(["status"])) === 0 && /deployed as 0.0.2/.test(logs.join("\n")), "status shows the deployed version");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  console.log(failures ? `FAILED (${failures})` : "PASSED");
  return failures ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
