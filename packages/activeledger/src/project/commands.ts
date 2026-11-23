import * as fs from "fs";
import * as path from "path";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveRequest } from "@activeledger/activeoptions";
import { auditFiles } from "../audit/audit";
import { atLeast } from "../audit/score";
import { Severity, SEVERITIES } from "../audit/types";
import { banner, wantBanner } from "./banner";
import {
  addToGitignore, checkKeyFile, Git, KeyFile, keyPathOf, Network, PROJECT_FILE, ProjectError, ProjectFile, readKeys, readProject,
  resolveProject, safeSource, writeKeys, writeProject,
} from "./files";
import { commandHelp, overview } from "./help";
import {
  checkExpect, contractTx, exampleTx, interpret, namespaceTx, onboardTx, Outcome, RefContext, sendToNetwork, Sender, sha256,
} from "./txs";

export interface ProjectFlags {
  project?: string;
  net?: string | string[];
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  quiet?: boolean;
  name?: string;
  type?: string;
  fixIgnore?: boolean;
  allowUnignoredKey?: boolean;
  all?: boolean;
  set?: string | string[];
  noAudit?: boolean;
  auditFailOn?: string;
  offline?: boolean;
}

export interface ProjectDeps {
  cwd: string;
  env: { [k: string]: string | undefined };
  git: Git;
  send: Sender;
  /** GET a URL, for status */
  get(url: string): Promise<any>;
  tty: boolean;
  /** Ask for a typed answer; true only when it matches `expect` */
  confirmTyped(question: string, expect: string): Promise<boolean>;
  audit(file: string, offline: boolean): Promise<{ worst?: Severity; lines: string[] }>;
  out: { log(t: string): void; error(t: string): void };
}

export const defaultDeps = (out: ProjectDeps["out"] = console): ProjectDeps => ({
  cwd: process.cwd(),
  env: process.env,
  git: (args, cwd) => {
    const r = require("child_process").spawnSync("git", args, { cwd, encoding: "utf8" });
    return { status: r.error ? null : r.status, stdout: r.stdout || "" };
  },
  send: async (url, body) => {
    const { data } = await ActiveRequest.send(url.replace(/\/$/, "") + "/", "POST", ["Content-Type: application/json"], body);
    return data;
  },
  get: async (url) => {
    const { data } = await ActiveRequest.send(url, "GET", []);
    return data;
  },
  tty: !!process.stdout.isTTY,
  confirmTyped: (question, expect) =>
    new Promise((resolve) => {
      const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} Type "${expect}" to go ahead: `, (a: string) => {
        rl.close();
        resolve(a.trim() === expect);
      });
    }),
  audit: async (file, offline) => {
    const report = await auditFiles([file], { offline });
    const findings = report.files.flatMap((f) => f.findings);
    const worst = SEVERITIES.find((s) => findings.some((f) => f.severity === s));
    return { worst, lines: findings.filter((f) => atLeast(f.severity, "medium")).map((f) => `${f.severity} ${f.rule} line ${f.line}: ${f.message}`) };
  },
  out,
});

interface Step {
  step: string;
  status: "ok" | "skipped" | "failed" | "dry-run";
  detail?: string;
  transaction?: any;
}

interface Loaded {
  file: string;
  project: ProjectFile;
  netName: string;
  net: Network;
  keyPath: string;
  keys: KeyFile;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A network from `--network name=url,url` (init) */
const parseNetworks = (list: string[]): { [name: string]: Network } => {
  const out: { [name: string]: Network } = {};
  for (const item of list) {
    const at = item.indexOf("=");
    if (at < 1) throw new ProjectError(`--net for init wants name=url[,url...], not "${item}"`);
    out[item.slice(0, at)] = { nodes: item.slice(at + 1).split(",").map((u) => u.trim()).filter(Boolean) };
  }
  return out;
};

const load = (flags: ProjectFlags, deps: ProjectDeps, opts: { keys: boolean }): Loaded => {
  const file = resolveProject(deps.cwd, flags.project, deps.env);
  const project = readProject(file);
  const chosen = Array.isArray(flags.net) ? flags.net[0] : flags.net;
  const names = Object.keys(project.networks);
  const netName = chosen || project.defaultNetwork || (names.length === 1 ? names[0] : "");
  if (!netName) throw new ProjectError(`more than one network (${names.join(", ")}) and no defaultNetwork; choose one with --net <name>`);
  const net = project.networks[netName];
  if (!net) throw new ProjectError(`no network "${netName}" in ${path.basename(file)} (it has ${names.join(", ")})`);
  const keyPath = keyPathOf(file);
  let keys: KeyFile = { version: 1, identities: {} };
  if (opts.keys) {
    const check = checkKeyFile(keyPath, deps.git, { allowUnignored: flags.allowUnignoredKey });
    for (const w of check.warnings) deps.out.error(`warning: ${w}`);
    if (!check.ok) throw new ProjectError(check.problems.join("\n"));
    keys = readKeys(keyPath);
  }
  return { file, project, netName, net, keyPath, keys };
};

const signerOf = (l: Loaded): { name: string; identity: any; streamId: string } => {
  const names = Object.keys(l.keys.identities);
  const name = l.net.identity || (names.length === 1 ? names[0] : "");
  if (!name) throw new ProjectError(names.length ? `more than one identity (${names.join(", ")}); set "identity" on the network ${l.netName}` : "no identity yet. Run `activeledger project identity new <name>`.");
  const identity = l.keys.identities[name];
  if (!identity) throw new ProjectError(`network ${l.netName} uses the identity "${name}", which is not in ${path.basename(l.keyPath)}`);
  const streamId = identity.streams && identity.streams[l.netName];
  if (!streamId) throw new ProjectError(`identity "${name}" is not onboarded on ${l.netName}. Run \`activeledger project identity onboard ${name}\`.`);
  return { name, identity, streamId };
};

/** A protected network needs more than --yes before anything is sent */
const guard = async (l: Loaded, flags: ProjectFlags, deps: ProjectDeps): Promise<void> => {
  if (!l.net.protected || flags.dryRun) return;
  if (deps.env.ACTIVELEDGER_CONFIRM === l.netName) return;
  if (deps.tty && (await deps.confirmTyped(`${l.netName} is a protected network.`, l.netName))) return;
  throw new ProjectError(`${l.netName} is a protected network. Set ACTIVELEDGER_CONFIRM=${l.netName} to say you mean it.`);
};

const submit = async (l: Loaded, deps: ProjectDeps, body: any): Promise<Outcome> => {
  const { reply } = await sendToNetwork(l.net, body, deps.send);
  return interpret(reply);
};

const hashFile = (l: Loaded, source: string): { text: string; hash: string; abs: string } => {
  const abs = safeSource(l.file, source);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e: any) {
    throw new ProjectError(`cannot read the contract source ${source}: ${e.message}`);
  }
  return { text, hash: sha256(text), abs };
};

/** The audit before a send: stops on a finding at or above the bar */
const auditGate = async (abs: string, flags: ProjectFlags, deps: ProjectDeps): Promise<string | undefined> => {
  if (flags.noAudit) return undefined;
  const bar = (flags.auditFailOn || "high") as Severity;
  if (!SEVERITIES.includes(bar)) throw new ProjectError(`--audit-fail-on must be one of ${SEVERITIES.join(", ")}`);
  const result = await deps.audit(abs, !!flags.offline);
  if (result.worst && atLeast(result.worst, bar)) return `the audit found ${result.worst} problems (use --no-audit to skip, --audit-fail-on to change the bar):\n    ${result.lines.join("\n    ")}`;
  return undefined;
};

const failedStep = (step: string, outcome: Outcome): Step => ({ step, status: "failed", detail: outcome.errors.join("; ") || "no node committed it" });

const print = (steps: Step[], flags: ProjectFlags, deps: ProjectDeps): number => {
  if (flags.json) deps.out.log(JSON.stringify({ steps }, null, 2));
  else {
    for (const s of steps) {
      deps.out.log(`  ${s.status.padEnd(8)} ${s.step}${s.detail ? ` - ${s.detail}` : ""}`);
      if (s.status === "dry-run" && s.transaction) deps.out.log(JSON.stringify(s.transaction, null, 2));
    }
  }
  return steps.some((s) => s.status === "failed") ? 1 : 0;
};

// ---- commands ----

const init = async (flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const file = path.resolve(deps.cwd, flags.project ? (flags.project.includes(path.sep) || flags.project.endsWith(".activeledger") ? flags.project : flags.project + ".activeledger") : PROJECT_FILE);
  const keyPath = keyPathOf(file);
  const steps: Step[] = [];
  const exists = fs.existsSync(file);
  if (exists && !flags.fixIgnore) throw new ProjectError(`${path.basename(file)} already exists; init never overwrites a project file (use --fix-ignore to only fix the .gitignore)`);
  if (!exists) {
    const nets = parseNetworks(asList(flags.net));
    if (!Object.keys(nets).length) nets.local = { nodes: ["http://127.0.0.1:5260"] };
    const project: ProjectFile = { version: 1, ...(flags.name ? { namespace: flags.name.toLowerCase() } : {}), defaultNetwork: Object.keys(nets)[0], networks: nets, contracts: {}, transactions: {} };
    writeProject(file, project);
    steps.push({ step: path.basename(file), status: "ok", detail: "created, commit this one" });
  }
  if (!fs.existsSync(keyPath)) {
    writeKeys(keyPath, { version: 1, identities: {} });
    steps.push({ step: path.basename(keyPath), status: "ok", detail: "created (mode 600), never commit it" });
  }
  const inside = deps.git(["rev-parse", "--is-inside-work-tree"], path.dirname(file));
  if (inside.status === 0 && inside.stdout.trim() === "true") {
    const added = addToGitignore(keyPath);
    steps.push({ step: ".gitignore", status: added ? "ok" : "skipped", detail: added ? `added ${path.basename(keyPath)}` : `${path.basename(keyPath)} is already listed` });
  }
  const check = checkKeyFile(keyPath, deps.git);
  if (!check.ok) steps.push({ step: "key file check", status: "failed", detail: check.problems.join(" ") });
  return steps;
};

const identityCmd = async (args: string[], flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const [sub, name, a, b] = args;
  const l = load(flags, deps, { keys: true });
  if (sub === "list") {
    const steps: Step[] = Object.entries(l.keys.identities).map(([n, id]) => ({
      step: n,
      status: "ok" as const,
      detail: `${id.type}; ${Object.entries(id.streams || {}).map(([net, s]) => `${net}: ${s}`).join(", ") || "not onboarded anywhere"}`,
    }));
    if (!steps.length) steps.push({ step: "identities", status: "skipped", detail: "none yet" });
    return steps;
  }
  if (!name) throw new ProjectError(`identity ${sub || ""} needs a name`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new ProjectError("an identity name is letters, numbers, dashes and underscores");
  if (sub === "new" || sub === "import") {
    if (l.keys.identities[name]) throw new ProjectError(`the identity "${name}" already exists`);
    let id: any;
    if (sub === "new") {
      const type = flags.type || "rsa";
      let keys: any;
      try {
        keys = new ActiveCrypto.KeyPair(type).generate();
      } catch (e: any) {
        throw new ProjectError(`cannot make a ${type} key: ${e.message}`);
      }
      id = { type, private: keys.prv.pkcs8pem, public: keys.pub.pkcs8pem };
    } else {
      if (!a || !b) throw new ProjectError("identity import <name> <private key file> <public key file>");
      id = { type: flags.type || "rsa", private: fs.readFileSync(path.resolve(deps.cwd, a), "utf8"), public: fs.readFileSync(path.resolve(deps.cwd, b), "utf8") };
    }
    if (flags.dryRun) return [{ step: `identity ${name}`, status: "dry-run", detail: "would be saved and onboarded", transaction: onboardTx(id) }];
    l.keys.identities[name] = id;
    writeKeys(l.keyPath, l.keys);
    const steps: Step[] = [{ step: `identity ${name}`, status: "ok", detail: `${id.type} key saved in ${path.basename(l.keyPath)}` }];
    return steps.concat(await onboard(l, name, flags, deps));
  }
  if (sub === "onboard") {
    if (!l.keys.identities[name]) throw new ProjectError(`no identity "${name}" in ${path.basename(l.keyPath)}`);
    return onboard(l, name, flags, deps);
  }
  throw new ProjectError(`identity: unknown command "${sub}" (new, import, onboard, list)`);
};

const onboard = async (l: Loaded, name: string, flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const id = l.keys.identities[name];
  const tx = onboardTx(id);
  if (flags.dryRun) return [{ step: `onboard ${name} on ${l.netName}`, status: "dry-run", transaction: tx }];
  await guard(l, flags, deps);
  const outcome = await submit(l, deps, tx);
  const created = outcome.newStreams[0];
  if (!outcome.ok || !created) return [{ ...failedStep(`onboard ${name} on ${l.netName}`, outcome), detail: (failedStep("", outcome).detail || "") + " (the key is saved; retry with `identity onboard`)" }];
  id.streams = { ...(id.streams || {}), [l.netName]: created.id };
  writeKeys(l.keyPath, l.keys);
  return [{ step: `onboard ${name} on ${l.netName}`, status: "ok", detail: `stream ${created.id}` }];
};

const registerNamespace = async (l: Loaded, ns: string | undefined, flags: ProjectFlags, deps: ProjectDeps): Promise<Step> => {
  const namespace = (ns || l.project.namespace || "").toLowerCase();
  if (!namespace) throw new ProjectError("no namespace: pass one or set it with `init --name`");
  if (l.net.namespaceRegistered && namespace === l.project.namespace) return { step: `namespace ${namespace} on ${l.netName}`, status: "skipped", detail: "already registered by this project" };
  const signer = signerOf(l);
  const tx = namespaceTx(signer.identity, signer.streamId, namespace);
  if (flags.dryRun) return { step: `namespace ${namespace} on ${l.netName}`, status: "dry-run", transaction: tx };
  await guard(l, flags, deps);
  const outcome = await submit(l, deps, tx);
  if (!outcome.ok) return { ...failedStep(`namespace ${namespace} on ${l.netName}`, outcome), detail: outcome.errors.some((e) => /Reserved/.test(e)) ? "Namespace Reserved: it is taken (by someone else, or by you from another project)" : failedStep("", outcome).detail };
  if (namespace === l.project.namespace) {
    l.net.namespaceRegistered = true;
    writeProject(l.file, l.project);
  }
  return { step: `namespace ${namespace} on ${l.netName}`, status: "ok" };
};

const deployOne = async (l: Loaded, name: string, flags: ProjectFlags, deps: ProjectDeps): Promise<Step> => {
  const c = l.project.contracts[name];
  if (!c) throw new ProjectError(`no contract "${name}" in the project (it has ${Object.keys(l.project.contracts).join(", ") || "none"})`);
  if (!l.project.namespace) throw new ProjectError("the project has no namespace; set one with `init --name`");
  const label = `contract ${name}@${c.version} on ${l.netName}`;
  const src = hashFile(l, c.source);
  const deployed = (l.net.contracts || {})[name];
  if (deployed && deployed.hash === src.hash && deployed.version === c.version) return { step: label, status: "skipped", detail: "already current" };
  if (deployed && deployed.version === c.version && deployed.hash !== src.hash) return { step: label, status: "failed", detail: `the source changed but "version" is still ${c.version}; bump it in the project file` };
  const blocked = await auditGate(src.abs, flags, deps);
  if (blocked) return { step: label, status: "failed", detail: blocked };
  const signer = signerOf(l);
  const tx = contractTx(signer.identity, signer.streamId, { namespace: l.project.namespace, name, version: c.version, source: src.text, contractId: deployed && deployed.id });
  if (flags.dryRun) return { step: label, status: "dry-run", transaction: tx };
  await guard(l, flags, deps);
  const outcome = await submit(l, deps, tx);
  if (!outcome.ok) return failedStep(label, outcome);
  const id = deployed ? deployed.id : (outcome.newStreams.find((s) => (s.name || "").startsWith("contract.")) || outcome.newStreams[0] || { id: "" }).id;
  if (!id) return { step: label, status: "failed", detail: "the node committed it but did not report the contract's stream id" };
  l.net.contracts = { ...(l.net.contracts || {}), [name]: { id, version: c.version, hash: src.hash } };
  writeProject(l.file, l.project);
  return { step: label, status: "ok", detail: `${deployed ? "updated" : "uploaded"}, stream ${id}` };
};

const contractCmd = async (args: string[], flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const [sub, name] = args;
  const l = load(flags, deps, { keys: sub !== "status" });
  const names = flags.all || (sub !== "status" && !name) ? Object.keys(l.project.contracts) : name ? [name] : Object.keys(l.project.contracts);
  if (sub === "status") {
    return names.map((n) => {
      const c = l.project.contracts[n];
      if (!c) throw new ProjectError(`no contract "${n}" in the project`);
      const d = (l.net.contracts || {})[n];
      const src = hashFile(l, c.source);
      if (!d) return { step: `${n}@${c.version}`, status: "skipped" as const, detail: `not deployed on ${l.netName}` };
      if (d.hash === src.hash && d.version === c.version) return { step: `${n}@${c.version}`, status: "ok" as const, detail: `deployed and current, stream ${d.id}` };
      return { step: `${n}@${c.version}`, status: "skipped" as const, detail: `deployed as ${d.version}, out of date (${d.hash === src.hash ? "version differs" : "source differs"})` };
    });
  }
  if (sub !== "upload" && sub !== "update") throw new ProjectError(`contract: unknown command "${sub}" (upload, update, status)`);
  if (!names.length) throw new ProjectError("the project has no contracts; add them under \"contracts\" in the project file");
  const steps: Step[] = [];
  for (const n of names) {
    const deployed = (l.net.contracts || {})[n];
    if (sub === "upload" && deployed) steps.push({ step: `contract ${n} on ${l.netName}`, status: "failed", detail: "already deployed here; use `contract update`" });
    else if (sub === "update" && !deployed) steps.push({ step: `contract ${n} on ${l.netName}`, status: "failed", detail: "not deployed here yet; use `contract upload`" });
    else steps.push(await deployOne(l, n, flags, deps));
    if (steps[steps.length - 1].status === "failed" && names.length > 1) break;
  }
  return steps;
};

const deployCmd = async (args: string[], flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const l = load(flags, deps, { keys: true });
  const steps: Step[] = [];
  if (l.project.namespace) {
    const s = await registerNamespace(l, undefined, flags, deps);
    steps.push(s);
    if (s.status === "failed") return steps;
  }
  const names = args.length && !flags.all ? args : Object.keys(l.project.contracts);
  for (const n of names) {
    const s = await deployOne(l, n, flags, deps);
    steps.push(s);
    if (s.status === "failed") break;
  }
  return steps;
};

const refContext = (l: Loaded, signer: { name: string; streamId: string }): RefContext => {
  const identities: { [n: string]: string } = {};
  for (const [n, id] of Object.entries(l.keys.identities)) if (id.streams && id.streams[l.netName]) identities[n] = id.streams[l.netName];
  const contracts: { [n: string]: string } = {};
  for (const [n, c] of Object.entries(l.net.contracts || {})) contracts[n] = c.id;
  return { identities, namespace: l.project.namespace, contracts };
};

const txCmd = async (args: string[], flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const [sub, name] = args;
  const l = load(flags, deps, { keys: sub === "run" });
  if (sub === "list") {
    const all = Object.entries(l.project.transactions);
    return all.length ? all.map(([n, t]) => ({ step: n, status: "ok" as const, detail: `${t.contract}${t.entry ? ` (${t.entry})` : ""}` })) : [{ step: "transactions", status: "skipped", detail: "none saved in the project" }];
  }
  if (sub !== "run") throw new ProjectError(`tx: unknown command "${sub}" (run, list)`);
  const names = flags.all ? Object.keys(l.project.transactions) : name ? [name] : [];
  if (!names.length) throw new ProjectError("tx run <name> or --all");
  const signer = signerOf(l);
  const ctx = refContext(l, signer);
  const steps: Step[] = [];
  for (const n of names) {
    const ex = l.project.transactions[n];
    if (!ex) throw new ProjectError(`no transaction "${n}" in the project (it has ${Object.keys(l.project.transactions).join(", ") || "none"})`);
    const tx = exampleTx(ex, ctx, signer, l.project, asList(flags.set));
    if (flags.dryRun) {
      steps.push({ step: `tx ${n}`, status: "dry-run", transaction: tx });
      continue;
    }
    await guard(l, flags, deps);
    const outcome = await submit(l, deps, tx);
    const diffs = checkExpect(outcome, ex.expect);
    steps.push(diffs.length ? { step: `tx ${n}`, status: "failed", detail: diffs.join("; ") } : { step: `tx ${n}`, status: "ok", detail: outcome.errors.length ? `refused as expected (${outcome.errors[0]})` : `committed${outcome.umid ? `, umid ${outcome.umid}` : ""}` });
    if (diffs.length) break;
  }
  return steps;
};

const statusCmd = async (flags: ProjectFlags, deps: ProjectDeps): Promise<Step[]> => {
  const l = load(flags, deps, { keys: false });
  const steps: Step[] = [];
  for (const node of l.net.nodes) {
    try {
      const s = await deps.get(node.replace(/\/$/, "") + "/a/status");
      steps.push({ step: node, status: "ok", detail: s && s.reference ? `answers, reference ${String(s.reference).slice(0, 12)}…` : "answers" });
    } catch (e: any) {
      steps.push({ step: node, status: "failed", detail: e && e.message ? e.message : "no answer" });
    }
  }
  steps.push({ step: `namespace ${l.project.namespace || "(none)"}`, status: l.net.namespaceRegistered ? "ok" : "skipped", detail: l.net.namespaceRegistered ? "registered by this project" : "not registered by this project on this network" });
  for (const [n, c] of Object.entries(l.project.contracts)) {
    const d = (l.net.contracts || {})[n];
    steps.push({ step: `contract ${n}@${c.version}`, status: d ? "ok" : "skipped", detail: d ? `deployed as ${d.version}, stream ${d.id}` : "not deployed" });
  }
  return steps;
};

/** `activeledger project <command> ...`: the exit code */
export const projectCommand = async (positionals: string[], flags: ProjectFlags, deps: ProjectDeps = defaultDeps()): Promise<number> => {
  const [sub, ...rest] = positionals;
  const art = wantBanner(deps.tty, deps.env, flags);
  try {
    if (!sub) {
      overview(art).forEach((l) => deps.out.log(l));
      return 0;
    }
    if (sub === "help") {
      const lines = rest[0] ? commandHelp(rest[0]) : overview(art);
      if (!lines) throw new ProjectError(`no project command "${rest[0]}"`);
      lines.forEach((l) => deps.out.log(l));
      return 0;
    }
    if (art && ["init", "deploy"].includes(sub)) banner().forEach((l) => deps.out.log(l));
    let steps: Step[];
    switch (sub) {
      case "init":
        steps = await init(flags, deps);
        break;
      case "identity":
        steps = await identityCmd(rest, flags, deps);
        break;
      case "namespace": {
        if (rest[0] !== "register") throw new ProjectError("namespace: the command is `register`");
        const l = load(flags, deps, { keys: true });
        steps = [await registerNamespace(l, rest[1], flags, deps)];
        break;
      }
      case "contract":
        steps = await contractCmd(rest, flags, deps);
        break;
      case "tx":
        steps = await txCmd(rest, flags, deps);
        break;
      case "deploy":
        steps = await deployCmd(rest, flags, deps);
        break;
      case "status":
        steps = await statusCmd(flags, deps);
        break;
      default:
        throw new ProjectError(`unknown project command "${sub}". Run \`activeledger project\` for the list.`);
    }
    return print(steps, flags, deps);
  } catch (e: any) {
    if (e instanceof ProjectError) {
      deps.out.error(flags.json ? JSON.stringify({ error: e.message }) : `error: ${e.message}`);
      return e.code;
    }
    deps.out.error(`error: ${e && e.message ? e.message : e}`);
    return 2;
  }
};
