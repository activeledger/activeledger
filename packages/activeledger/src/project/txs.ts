import * as crypto from "crypto";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Example, KeyIdentity, Network, ProjectFile, ProjectError } from "./files";

/** What a send answered: parsed from the node's reply */
export interface Outcome {
  ok: boolean;
  umid?: string;
  total: number;
  vote: number;
  commit: number;
  errors: string[];
  newStreams: { id: string; name?: string }[];
  updatedStreams: { id: string; name?: string }[];
  raw: any;
}

export type Sender = (url: string, body: any) => Promise<any>;

export const sha256 = (text: string | Buffer): string => crypto.createHash("sha256").update(text).digest("hex");

/** Read the node's reply: committed only when someone committed and nothing errored */
export const interpret = (reply: any): Outcome => {
  const s = reply && reply.$summary ? reply.$summary : {};
  const errors: string[] = Array.isArray(s.errors) ? s.errors.map(String) : [];
  if (reply && reply.error && typeof reply.error === "string") errors.push(reply.error);
  if (reply && reply.$summary === undefined && !errors.length) errors.push("the node's reply had no summary");
  const total = Number(s.total) || 0;
  const commit = Number(s.commit) || 0;
  return {
    ok: !errors.length && commit > 0,
    umid: reply && reply.$umid,
    total,
    vote: Number(s.vote) || 0,
    commit,
    errors,
    newStreams: (reply && reply.$streams && reply.$streams.new) || [],
    updatedStreams: (reply && reply.$streams && reply.$streams.updated) || [],
    raw: reply,
  };
};

/** The key pair of a stored identity */
export const keyPairOf = (id: KeyIdentity): ActiveCrypto.KeyPair => new ActiveCrypto.KeyPair(id.type, id.private);

const sign = (id: KeyIdentity, body: any): string => keyPairOf(id).sign(body);

/** Self-signed: the identity does not have a stream id yet */
export const onboardTx = (id: KeyIdentity): any => {
  const $tx = { $namespace: "default", $contract: "onboard", $i: { identity: { type: id.type, publicKey: id.public } }, $o: {} };
  return { $tx, $selfsign: true, $sigs: { identity: sign(id, $tx) } };
};

export const namespaceTx = (id: KeyIdentity, streamId: string, namespace: string): any => {
  const $tx = { $namespace: "default", $contract: "namespace", $i: { [streamId]: { namespace } } };
  return { $tx, $sigs: { [streamId]: sign(id, $tx) } };
};

export const contractTx = (
  id: KeyIdentity,
  streamId: string,
  c: { namespace: string; name: string; version: string; source: string; contractId?: string; lock?: string[] | "all" }
): any => {
  const input: any = { version: c.version, namespace: c.namespace, name: c.name, contract: Buffer.from(c.source).toString("base64") };
  if (c.lock) input.lock = c.lock;
  const $tx: any = { $namespace: "default", $contract: "contract", $i: { [streamId]: input } };
  if (c.contractId) {
    $tx.$entry = "update";
    $tx.$o = { [c.contractId]: {} };
  }
  return { $tx, $sigs: { [streamId]: sign(id, $tx) } };
};

/** Where the references in an example point on one network */
export interface RefContext {
  /** identity name -> stream id, for the identities this project holds */
  identities: { [name: string]: string };
  namespace?: string;
  contracts: { [name: string]: string };
}

/** `@alice`, `@namespace` and `@contract:<name>` as a whole string or a whole key; anything else is left alone */
export const resolveRefs = (value: any, ctx: RefContext): any => {
  const one = (s: string): string => {
    if (!s.startsWith("@")) return s;
    const name = s.slice(1);
    if (name === "namespace") {
      if (!ctx.namespace) throw new ProjectError("an example uses @namespace but the project has no namespace");
      return ctx.namespace;
    }
    if (name.startsWith("contract:")) {
      const id = ctx.contracts[name.slice(9)];
      if (!id) throw new ProjectError(`an example uses @${name}, which is not deployed on this network`);
      return id;
    }
    const id = ctx.identities[name];
    if (!id) throw new ProjectError(`an example uses @${name}, which is not an identity onboarded on this network`);
    return id;
  };
  if (typeof value === "string") return one(value);
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ctx));
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[one(k)] = resolveRefs(v, ctx);
    return out;
  }
  return value;
};

/** `key=value` into a path in an object: a.b.c=1 (numbers, true, false and null are read as such) */
export const applySet = (target: any, assignment: string): void => {
  const at = assignment.indexOf("=");
  if (at < 1) throw new ProjectError(`--set wants key=value, not "${assignment}"`);
  const keys = assignment.slice(0, at).split(".");
  const raw = assignment.slice(at + 1);
  let value: any = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // a plain string
  }
  let node = target;
  for (const k of keys.slice(0, -1)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw new ProjectError(`--set cannot set ${k}`);
    if (!node[k] || typeof node[k] !== "object") node[k] = {};
    node = node[k];
  }
  const last = keys[keys.length - 1];
  if (last === "__proto__" || last === "constructor" || last === "prototype") throw new ProjectError(`--set cannot set ${last}`);
  node[last] = value;
};

/** An example as a signed transaction, signed by the one identity the project holds for the network */
export const exampleTx = (
  example: Example,
  ctx: RefContext,
  signer: { name: string; identity: KeyIdentity; streamId: string },
  project: ProjectFile,
  sets: string[] = []
): any => {
  const copy: Example = JSON.parse(JSON.stringify(example));
  for (const s of sets) applySet(copy, s);
  const contractId = ctx.contracts[copy.contract];
  const $tx: any = {
    $namespace: project.namespace,
    $contract: contractId || copy.contract,
    $i: resolveRefs(copy.input || {}, ctx),
    $o: resolveRefs(copy.output || {}, ctx),
  };
  if (!$tx.$namespace) throw new ProjectError("the project has no namespace to run the transaction in");
  if (copy.entry) $tx.$entry = copy.entry;
  const inputs = Object.keys($tx.$i);
  const foreign = inputs.filter((k) => k !== signer.streamId);
  if (foreign.length) throw new ProjectError(`the example's inputs (${foreign.join(", ")}) are not streams of the identity "${signer.name}" that signs it; use @${signer.name}`);
  return { $tx, $sigs: { [signer.streamId]: sign(signer.identity, $tx) } };
};

/** Send to the first node that answers. A refusal is an answer; only a failure to reach a node moves on to the next. */
export const sendToNetwork = async (net: Network, body: any, send: Sender): Promise<{ node: string; reply: any }> => {
  const failures: string[] = [];
  for (const node of net.nodes) {
    try {
      const reply = await send(node, body);
      return { node, reply };
    } catch (e: any) {
      failures.push(`${node}: ${e && e.message ? e.message : e}`);
    }
  }
  throw new ProjectError(`no node answered:\n  ${failures.join("\n  ")}`);
};

/** What a reply was compared with, as a list of differences (empty when it met `expect`) */
/** Default: at least one node committed and nothing errored (the reply is built as soon as the vote is decided, so the other nodes may still be committing) */
export const checkExpect = (outcome: Outcome, expect: Example["expect"] = { commit: 1 }): string[] => {
  const diffs: string[] = [];
  const e = expect || { commit: 1 };
  if (e.error !== undefined) {
    if (!outcome.errors.some((m) => m.includes(String(e.error)))) diffs.push(`expected an error containing "${e.error}", got ${outcome.errors.length ? JSON.stringify(outcome.errors) : "none"}`);
    return diffs;
  }
  if (outcome.errors.length) diffs.push(`errors: ${JSON.stringify(outcome.errors)}`);
  if (e.commit === "all") {
    if (!outcome.total || outcome.commit < outcome.total) diffs.push(`expected every node to commit, ${outcome.commit} of ${outcome.total} did`);
  } else if (typeof e.commit === "number" || e.commit === undefined) {
    const want = typeof e.commit === "number" ? e.commit : 1;
    if (outcome.commit < want) diffs.push(`expected at least ${want} commit${want === 1 ? "" : "s"}, got ${outcome.commit}`);
  }
  return diffs;
};
