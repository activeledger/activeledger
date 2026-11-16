import { ActiveRequest, Cli } from "@activeledger/activeoptions";
import { base } from "./hybrid";

/**
 * `activeledger reload`: make the running node re-read its `config.json`
 * without a restart, and tell its worker processes. It asks the node's own
 * `/a/admin-reload`, which only answers when the node has `"remote": true`
 * (and only this host or a neighbour may call it); otherwise a restart is
 * the way to pick up a change.
 */
export const reloadCommand = async (
  json: boolean,
  out: { log(t: string): void; error(t: string): void } = console
): Promise<number> => {
  try {
    const { data } = await ActiveRequest.send(`${base()}/a/admin-reload`, "GET");
    if (!data) {
      out.error("could not reach the node");
      return Cli.ExitCode.STATE;
    }
    const answer = data as { status?: string; message?: string; build?: number };
    if (answer?.status === "success") {
      out.log(json ? JSON.stringify(answer) : `reloaded config.json (build ${answer.build})`);
      return Cli.ExitCode.OK;
    }
    if (answer?.message === "remote disabled") {
      out.error('reload is off on this node: set "remote": true in config.json and restart it once, or restart it to pick up the change');
      return Cli.ExitCode.FAIL;
    }
    out.error(`reload failed: ${answer?.message ?? "unknown error"}`);
    return Cli.ExitCode.FAIL;
  } catch (e: any) {
    out.error(`could not reach the node: ${e?.message ?? e}`);
    return Cli.ExitCode.STATE;
  }
};
