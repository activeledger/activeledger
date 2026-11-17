import * as readline from "readline";
import { ActiveOptions, ActiveRequest, Cli } from "@activeledger/activeoptions";

/**
 * `activeledger prune [days]`: remove what a node no longer needs from its own
 * stores, keeping the last `days` days (30 unless said). Never the ledger.
 *
 *   always            the errors database (documents already processed) and its archive
 *   --include-umids   the umid index in the events database (umid: and fail: rows)
 *   --include-events  the contract events in the events database
 *
 * Databases it does not recognise are listed and, one at a time and only when
 * you say yes (or name them with --delete-db), deleted whole. See
 * docs/guide/operate/prune.md for what each choice costs.
 */

export const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Under this many days of the umid index, a node or hybrid catching up can miss rows */
const UMID_WARN_DAYS = 30;
/** One page asks the server to remove at most this many rows */
const PAGE_LIMIT = 5000;
/** A gap between pages, so a big prune leaves the node room for its own work */
const PAGE_PAUSE_MS = 25;
/** A database name is a plain name: it becomes a directory name on the storage server */
const DB_NAME = /^[A-Za-z0-9_.-]+$/;

export interface PruneFlags {
  includeEvents?: boolean;
  includeUmids?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** --delete-db <name>, given once or several times */
  deleteDb?: string | string[] | boolean;
  noCompact?: boolean;
  json?: boolean;
}

export interface PruneDeps {
  /** The db section of config.json */
  loadDb(): any;
  request(url: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<any>;
  /** Ask a yes or no question. Anything but an explicit yes is no. */
  confirm(question: string): Promise<boolean>;
  interactive: boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  out: { log(t: string): void; error(t: string): void };
}

export const defaultDeps = (out: PruneDeps["out"] = console): PruneDeps => ({
  loadDb: () => {
    ActiveOptions.parseConfig();
    return ActiveOptions.get<any>("db", {});
  },
  request: async (url, method, body) => {
    const { data } = await ActiveRequest.send(url, method, [], body as any);
    return data;
  },
  confirm: (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    }),
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  out,
});

interface Target {
  db: string;
  kind: "error" | "umid" | "fail" | "event";
  label: string;
  requireProcessed?: boolean;
}

interface Tally {
  label: string;
  db: string;
  removed: number;
  scanned: number;
  kept: number;
}

const n = (v: number): string => v.toLocaleString("en-GB");
const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const names = (v: PruneFlags["deleteDb"]): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(String);

export const pruneCommand = async (
  daysArg: string | undefined,
  flags: PruneFlags,
  deps: PruneDeps = defaultDeps()
): Promise<number> => {
  const { out } = deps;
  const say = (text: string) => {
    if (!flags.json) out.log(text);
  };

  // days: how many to keep
  let days = DEFAULT_DAYS;
  if (daysArg !== undefined) {
    if (!/^\d+$/.test(daysArg) || Number(daysArg) < 1) {
      out.error(`days must be a whole number of at least 1 (the days of history to keep), not "${daysArg}"`);
      return Cli.ExitCode.FAIL;
    }
    days = Number(daysArg);
  }

  // Where the node's storage is
  const db = deps.loadDb() || {};
  if (!db.selfhost) {
    out.error("prune works on the node's own (embedded) store; this node is configured for CouchDB");
    return Cli.ExitCode.FAIL;
  }
  const base = `http://${db.selfhost.host}:${db.selfhost.port}`;
  const ledger: string = db.database || "activeledger";
  const events: string = db.event || "activeledgerevents";
  const errors: string = db.error || "activeledgererrors";
  const archive = `${errors}_archive`;
  const protectedNames = new Set([ledger, events, errors, archive]);

  // Databases named for deletion are checked before anything is touched
  const asked = [...new Set(names(flags.deleteDb))];
  for (const name of asked) {
    if (!DB_NAME.test(name) || name.includes("..")) {
      out.error(`--delete-db "${name}" is not a plain database name`);
      return Cli.ExitCode.FAIL;
    }
    if (protectedNames.has(name)) {
      out.error(`--delete-db "${name}" is one of this node's own databases. Prune clears old rows from it; it never deletes it`);
      return Cli.ExitCode.FAIL;
    }
  }

  let existing: unknown;
  try {
    existing = await deps.request(`${base}/_all_dbs`, "GET");
  } catch {
    existing = undefined;
  }
  if (!Array.isArray(existing)) {
    out.error(`could not reach the node's storage at ${base}. Is the node running?`);
    return Cli.ExitCode.STATE;
  }
  const present = new Set(existing.map(String));

  // What will be pruned
  const targets: Target[] = [
    { db: errors, kind: "error", label: "errors", requireProcessed: true },
    { db: archive, kind: "error", label: "archived errors", requireProcessed: false },
  ];
  if (flags.includeUmids) {
    targets.push({ db: events, kind: "umid", label: "umid index" }, { db: events, kind: "fail", label: "failure index" });
  }
  if (flags.includeEvents) targets.push({ db: events, kind: "event", label: "contract events" });

  if (flags.includeUmids && days < UMID_WARN_DAYS && !flags.yes) {
    const proceed =
      deps.interactive &&
      (await deps.confirm(
        `Keeping only ${days} days of the umid index means a node or hybrid catching up from this node's umid list, or asking for a commit attestation, cannot find older ones. Continue?`
      ));
    if (!proceed) {
      out.error(
        deps.interactive
          ? "stopped: nothing was removed"
          : `stopped: under ${UMID_WARN_DAYS} days with --include-umids needs --yes when there is no terminal. Nothing was removed`
      );
      return Cli.ExitCode.FAIL;
    }
  }

  const before = deps.now() - days * DAY_MS;
  say(
    `${flags.dryRun ? "Dry run: nothing will be removed. " : ""}Keeping the last ${days} day${days === 1 ? "" : "s"}; removing anything older than ${new Date(before).toISOString()}.`
  );

  const tallies: Tally[] = [];
  for (const target of targets) {
    if (!present.has(target.db)) {
      say(`  ${target.label}: no ${target.db} database, skipped`);
      continue;
    }
    const tally: Tally = { label: target.label, db: target.db, removed: 0, scanned: 0, kept: 0 };
    let after: string | undefined;
    for (;;) {
      const page = await deps.request(`${base}/${target.db}/_prune`, "POST", {
        kind: target.kind,
        before,
        after,
        limit: PAGE_LIMIT,
        dryRun: !!flags.dryRun,
        requireProcessed: target.requireProcessed,
      });
      if (!page || page.error || typeof page.removed !== "number") {
        out.error(`${target.label}: ${page?.error ? `the storage refused: ${page.error}` : "no answer from the storage"}`);
        return Cli.ExitCode.FAIL;
      }
      tally.removed += page.removed;
      tally.scanned += page.scanned;
      tally.kept += page.kept;
      if (page.done) break;
      after = page.next;
      say(`  ${target.label}: ${flags.dryRun ? "would remove" : "removed"} ${n(tally.removed)} so far`);
      await deps.sleep(PAGE_PAUSE_MS);
    }
    say(`  ${target.label}: ${flags.dryRun ? "would remove" : "removed"} ${n(tally.removed)} (looked at ${n(tally.scanned)}, kept ${n(tally.kept)})`);
    tallies.push(tally);
  }

  // Databases this does not recognise: asked about one at a time, default no
  const strangers = [...present].filter((name) => !protectedNames.has(name)).sort();
  const deleted: string[] = [];
  const stillThere: string[] = [];
  for (const name of asked) {
    if (!present.has(name)) say(`  --delete-db ${name}: there is no such database`);
  }
  for (const name of strangers) {
    const info = await deps.request(`${base}/${name}`, "GET").catch(() => undefined);
    const size = info && typeof info.data_size === "number" ? `, ${mb(info.data_size)}` : "";
    const count = info && typeof info.doc_count === "number" ? `${n(info.doc_count)} documents` : "size unknown";
    const describe = `${name} (${count}${size})`;
    let remove = asked.includes(name);
    if (!remove && deps.interactive && !flags.json) {
      remove = await deps.confirm(
        `Found a database this node does not use: ${describe}. It may belong to another tool using this storage. Delete it whole?`
      );
    }
    if (!remove) {
      stillThere.push(name);
      say(`  left alone: ${describe}${deps.interactive ? "" : " (use --delete-db " + name + " to delete it)"}`);
      continue;
    }
    if (flags.dryRun) {
      say(`  would delete database ${describe}`);
      continue;
    }
    const answer = await deps.request(`${base}/${name}`, "DELETE");
    if (answer && answer.ok) {
      deleted.push(name);
      say(`  deleted database ${describe}`);
    } else {
      out.error(`could not delete ${name}: ${answer?.error ?? "no answer from the storage"}`);
      return Cli.ExitCode.FAIL;
    }
  }

  // LevelDB gives space back when it compacts
  const compacted: string[] = [];
  if (!flags.dryRun && !flags.noCompact) {
    for (const db of [...new Set(tallies.filter((t) => t.removed > 0).map((t) => t.db))]) {
      await deps.request(`${base}/${db}/_compact`, "GET").catch(() => undefined);
      compacted.push(db);
      say(`  compacting ${db}`);
    }
  }

  const total = tallies.reduce((sum, t) => sum + t.removed, 0);
  if (flags.json) {
    out.log(JSON.stringify({ days, before, dryRun: !!flags.dryRun, removed: total, tallies, deleted, left: stillThere, compacted }));
  } else {
    say(`${flags.dryRun ? "Would remove" : "Removed"} ${n(total)} row${total === 1 ? "" : "s"} in total.`);
  }
  return Cli.ExitCode.OK;
};
