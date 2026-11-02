import { Process } from "../../packages/protocol/src/protocol/process";
import * as fs from "fs";

export interface RaisedError {
  code: number;
  message: string;
  stop?: boolean;
  priority?: number;
}

export interface ProcessFixture {
  proc: any;
  entry: any;
  raised: RaisedError[];
  events: Array<{ event: string; payload: any }>;
}

export interface FixtureOptions {
  entry?: any;
  right?: any;
  db?: any;
  dbe?: any;
}

const vmscriptPath = "./packages/protocol/src/protocol/vmscript.js";

/**
 * A real Process (so real Shared, PermissionsChecker and VM controller) whose
 * ledger errors and emitted events are recorded instead of acted on. Build it
 * before changing directory: the constructor needs vmscript.js at that path.
 */
export const buildProcess = (options: FixtureOptions = {}): ProcessFixture => {
  const entry: any = {
    $umid: "umid-under-test",
    $origin: "origin-node",
    $broadcast: false,
    $nodes: { self: {} },
    $tx: { $namespace: "default", $contract: "onboard", $i: {}, $o: {} },
    $sigs: {},
    ...(options.entry || {}),
  };

  fs.writeFileSync(vmscriptPath, "{}");
  let proc: any;
  try {
    proc = new Process(
      entry,
      "localhost:5259",
      "self",
      options.right ||
        ({
          reference: "right",
          knock: (): Promise<any> => new Promise(() => {}),
        } as any),
      (options.db || {}) as any,
      (options.dbe || {}) as any,
      {} as any,
    );
  } finally {
    if (fs.existsSync(vmscriptPath)) {
      fs.unlinkSync(vmscriptPath);
    }
  }

  const raised: RaisedError[] = [];
  const events: Array<{ event: string; payload: any }> = [];

  proc.shared.raiseLedgerError = (
    code: number,
    error: Error | string,
    stop?: boolean,
    priority?: number
  ) => {
    raised.push({
      code,
      message: (error as Error)?.message ?? String(error),
      stop,
      priority,
    });
    return Promise.resolve();
  };
  proc.emit = (event: string, payload?: any) => {
    events.push({ event, payload });
    return true;
  };

  return { proc, entry, raised, events };
};

/**
 * $nodes from a string, one character per node (n0, n1, ...): y voted yes,
 * n voted no, e is an early placeholder that claims a yes.
 */
export const voteNodes = (spec: string): { [node: string]: any } => {
  const out: { [node: string]: any } = {};
  spec.split("").forEach((c, i) => {
    out[`n${i}`] = c === "e" ? { vote: true, early: true } : { vote: c === "y" };
  });
  return out;
};
