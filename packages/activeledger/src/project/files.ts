import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface DeployedContract {
  id: string;
  version: string;
  /** sha256 of the source last sent */
  hash: string;
}

export interface Network {
  nodes: string[];
  identity?: string;
  protected?: boolean;
  insecure?: boolean;
  /** set once this project's identity has registered the namespace on this network */
  namespaceRegistered?: boolean;
  contracts?: { [name: string]: DeployedContract };
}

export interface Example {
  contract: string;
  entry?: string;
  input?: any;
  output?: any;
  expect?: { commit?: "all" | number; error?: string; [k: string]: any };
}

export interface ProjectFile {
  version: 1;
  namespace?: string;
  defaultNetwork?: string;
  networks: { [name: string]: Network };
  contracts: { [name: string]: { source: string; version: string } };
  transactions: { [name: string]: Example };
}

export interface KeyIdentity {
  type: string;
  private: string;
  public: string;
  /** the identity's stream id on each network it is onboarded on */
  streams?: { [network: string]: string };
}

export interface KeyFile {
  version: 1;
  identities: { [name: string]: KeyIdentity };
}

export class ProjectError extends Error {
  constructor(message: string, public code = 2) {
    super(message);
  }
}

export const PROJECT_FILE = ".activeledger";
const SUFFIX = ".activeledger";

/** The key file that goes with a project file: its name plus -key */
export const keyPathOf = (projectPath: string): string => projectPath + "-key";

/** Project files in one folder: `.activeledger` and `<name>.activeledger` */
export const projectsIn = (dir: string): string[] => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n === PROJECT_FILE || (n.endsWith(SUFFIX) && n.length > SUFFIX.length)).sort().map((n) => path.join(dir, n));
};

/**
 * Which project file: --project (a name or a path), then ACTIVELEDGER_PROJECT, then the only one in this folder or the nearest parent
 * that has any. Several and none named is an error that lists them.
 */
export const resolveProject = (cwd: string, project?: string, env: { [k: string]: string | undefined } = {}, probe?: Probe): string => {
  const wanted = project || env.ACTIVELEDGER_PROJECT;
  if (wanted) {
    const candidates = [path.resolve(cwd, wanted), path.resolve(cwd, wanted + SUFFIX), path.resolve(cwd, wanted === "default" ? PROJECT_FILE : "\0")];
    const found = candidates.find((c) => !c.includes("\0") && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) throw new ProjectError(`no project file "${wanted}" (looked for ${candidates.filter((c) => !c.includes("\0")).join(" and ")})`);
    return found;
  }
  // Looks upward, but only as far as the repository this folder is in (or the home folder): a project file in some
  // folder above is not something this folder's work should pick up, and it must be one this user owns
  const home = os.homedir();
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const here = projectsIn(dir);
    if (here.length === 1) {
      ownedByUser(here[0], probe);
      return here[0];
    }
    if (here.length > 1) throw new ProjectError(`more than one project file in ${dir}: ${here.map((p) => path.basename(p)).join(", ")}. Choose one with --project <name>.`);
    if (fs.existsSync(path.join(dir, ".git")) || dir === home || path.dirname(dir) === dir) break;
  }
  throw new ProjectError("no project file found. Run `activeledger project init` first.");
};

/** Who owns a path itself (not what a link points at), and whether it is a link */
export type Probe = (file: string) => { uid: number; isLink: boolean };
const realProbe: Probe = (f) => {
  const st = fs.lstatSync(f);
  return { uid: st.uid, isLink: st.isSymbolicLink() };
};

/**
 * A project file found by looking upward must be a real file (not a link) owned by the user running the command, in a
 * folder the user owns: otherwise someone else could have put it there.
 */
const ownedByUser = (file: string, probe: Probe = realProbe): void => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return;
  const f = probe(file);
  const d = probe(path.dirname(file));
  if (f.isLink) throw new ProjectError(`${file} is a symbolic link, so it is not used when found by searching upward. Name it with --project if you trust it.`);
  if (f.uid !== uid || d.uid !== uid) throw new ProjectError(`${file} (or the folder it is in) is owned by another user, so it is not used. Name it with --project if you trust it.`);
};

/**
 * Where a contract's source may be read from: a .ts or .js file inside the project's folder, and never the key file.
 * The project file can come from anyone (a clone, a pull request), so its paths are not trusted.
 */
export const safeSource = (projectFile: string, source: string): string => {
  const base = fs.realpathSync(path.dirname(projectFile));
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(base, source));
  } catch (e: any) {
    throw new ProjectError(`cannot read the contract source ${source}: ${e.message}`);
  }
  const rel = path.relative(base, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new ProjectError(`the contract source ${source} is outside the project folder, so it is not sent`);
  if (!/\.(ts|js)$/.test(abs) || /-key$/.test(abs) || path.basename(abs).startsWith(".activeledger")) throw new ProjectError(`the contract source ${source} is not a .ts or .js contract file, so it is not sent`);
  return abs;
};

const isObject = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);

/** The problems with a parsed project file, empty when it is usable */
export const validateProject = (p: any): string[] => {
  const errors: string[] = [];
  if (!isObject(p)) return ["the file is not a JSON object"];
  if (p.version !== 1) errors.push(`"version" must be 1 (this file says ${JSON.stringify(p.version)})`);
  if (p.namespace !== undefined && !(typeof p.namespace === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(p.namespace))) errors.push('"namespace" must be a name of letters, numbers, dots, dashes or underscores');
  if (!isObject(p.networks) || !Object.keys(p.networks).length) errors.push('"networks" needs at least one network');
  else {
    for (const [n, net] of Object.entries<any>(p.networks)) {
      if (!isObject(net) || !Array.isArray(net.nodes) || !net.nodes.length || net.nodes.some((u: any) => typeof u !== "string")) errors.push(`network "${n}" needs "nodes", a list of URLs`);
      else {
        for (const u of net.nodes) {
          try {
            const url = new URL(u);
            const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
            if (url.protocol !== "https:" && !(url.protocol === "http:" && (local || net.insecure === true))) errors.push(`network "${n}": ${u} must be https (or http to this machine, or set "insecure": true)`);
          } catch {
            errors.push(`network "${n}": "${u}" is not a URL`);
          }
        }
      }
    }
    if (p.defaultNetwork !== undefined && !p.networks[p.defaultNetwork]) errors.push(`"defaultNetwork" names "${p.defaultNetwork}", which is not in "networks"`);
  }
  if (p.contracts !== undefined) {
    if (!isObject(p.contracts)) errors.push('"contracts" must be an object');
    else for (const [n, c] of Object.entries<any>(p.contracts)) if (!isObject(c) || typeof c.source !== "string" || typeof c.version !== "string") errors.push(`contract "${n}" needs "source" and "version"`);
  }
  if (p.transactions !== undefined) {
    if (!isObject(p.transactions)) errors.push('"transactions" must be an object');
    else for (const [n, t] of Object.entries<any>(p.transactions)) if (!isObject(t) || typeof t.contract !== "string") errors.push(`transaction "${n}" needs "contract"`);
  }
  return errors;
};

export const readProject = (file: string): ProjectFile => {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new ProjectError(`cannot read ${file}: ${e.message}`);
  }
  const errors = validateProject(raw);
  if (errors.length) throw new ProjectError(`${path.basename(file)} is not valid:\n  ${errors.join("\n  ")}`);
  return { contracts: {}, transactions: {}, ...raw };
};

/** Through a temp file and a rename, so a crash never leaves half a file */
export const writeAtomic = (file: string, content: string, mode?: number): void => {
  // A name nobody can guess, made exclusively with the final mode from the first byte, so a planted file or link at a
  // predictable name is never written through and a key is never readable by others, even briefly
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode === undefined ? 0o666 : mode);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};

export const writeProject = (file: string, project: ProjectFile): void => writeAtomic(file, JSON.stringify(project, null, 2) + "\n");

export const readKeys = (file: string): KeyFile => {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.version === 1 && isObject(raw.identities)) return raw;
  } catch (e: any) {
    if (e.code === "ENOENT") return { version: 1, identities: {} };
    throw new ProjectError(`cannot read ${path.basename(file)}: ${e.message}`);
  }
  throw new ProjectError(`${path.basename(file)} is not a key file`);
};

export const writeKeys = (file: string, keys: KeyFile): void => writeAtomic(file, JSON.stringify(keys, null, 2) + "\n", 0o600);

/** A way to run git, so the checks can be tested without one */
export type Git = (args: string[], cwd: string) => { status: number | null; stdout: string };

export interface KeyCheck {
  ok: boolean;
  /** Why not, with what to do */
  problems: string[];
  /** Said once and carried on: no git to ask */
  warnings: string[];
}

/**
 * The key file must be safe to hold keys: git-ignored and not tracked (when the folder is in a repository), and not readable by others.
 * Outside a repository, or with no git, it warns and carries on.
 */
export const checkKeyFile = (keyPath: string, git: Git, opts: { allowUnignored?: boolean } = {}): KeyCheck => {
  const problems: string[] = [];
  const warnings: string[] = [];
  const dir = path.dirname(keyPath);
  const name = path.basename(keyPath);
  const inside = git(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside.status === null) warnings.push("git was not found, so the key file could not be checked against .gitignore");
  else if (inside.status !== 0 || inside.stdout.trim() !== "true") warnings.push("this folder is not in a git repository, so the key file could not be checked against .gitignore");
  else {
    const ignored = git(["check-ignore", "-q", "--", name], dir).status === 0;
    const tracked = git(["ls-files", "--error-unmatch", "--", name], dir).status === 0;
    if (tracked) problems.push(`${name} is tracked by git, so its keys are already in the repository. Remove it from git with \`git rm --cached ${name}\`, then rotate the keys it holds.`);
    if (!ignored) {
      const msg = `${name} is not ignored by git. Run \`activeledger project init --fix-ignore\` (or add "${name}" to .gitignore).`;
      if (opts.allowUnignored) warnings.push(msg + " (continuing because of --allow-unignored-key)");
      else problems.push(msg);
    }
  }
  try {
    const link = fs.lstatSync(keyPath);
    if (link.isSymbolicLink()) problems.push(`${name} is a symbolic link; keys are only read from a real file.`);
    if (typeof process.getuid === "function" && link.uid !== process.getuid()) problems.push(`${name} is owned by another user.`);
    const mode = fs.statSync(keyPath).mode & 0o777;
    if (mode & 0o077) problems.push(`${name} can be read by other users (mode ${mode.toString(8)}). Run \`chmod 600 ${name}\`.`);
  } catch {
    // not made yet
  }
  return { ok: !problems.length, problems, warnings };
};

/** Add the key file to .gitignore in its folder, once */
export const addToGitignore = (keyPath: string): boolean => {
  const dir = path.dirname(keyPath);
  const ignore = path.join(dir, ".gitignore");
  const name = path.basename(keyPath);
  let current = "";
  try {
    current = fs.readFileSync(ignore, "utf8");
  } catch {
    // none yet
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === name || l.trim() === "/" + name)) return false;
  fs.writeFileSync(ignore, current + (current && !current.endsWith("\n") ? "\n" : "") + name + "\n");
  return true;
};
