#!/usr/bin/env node

/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions, Cli } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { CLIHandler } from "./cli/cli";
import { supernodeProgram } from "./cli/program";
import { checkConfigFile, status, waitForExit } from "./cli/health";
import { hybridCommand } from "./cli/hybrid";
import { reloadCommand } from "./cli/reload";
import { pruneCommand } from "./cli/prune";
import { auditCommand } from "./audit/audit";
import { projectCommand } from "./project/commands";
import { PIDHandler } from "./cli/pid";
import { ensureAttestKey, withAttestKey } from "./cli/identity";

// Set during build
const version = "unset";

// Initalise CLI Options
ActiveOptions.init();

// Help, version and unknown names are settled before anything starts
const cli = Cli.runCli(supernodeProgram(version), process.argv.slice(2));
if (cli.exit !== undefined) {
  process.exit(cli.exit);
}

// Commands that need neither an identity nor a running node
if (cli.command === "check-config") {
  process.exit(
    checkConfigFile(
      ActiveOptions.get<string>("config", "./config.json"),
      !!cli.flags.json
    )
  );
}
if (cli.command === "hybrid") {
  hybridCommand(
    cli.positionals[1],
    cli.positionals[2],
    !!cli.flags.json,
    console,
    cli.flags.out as string | undefined
  ).then((code) => process.exit(code));
}
if (cli.command === "reload") {
  reloadCommand(!!cli.flags.json).then((code) => process.exit(code));
}
if (cli.command === "prune") {
  pruneCommand(cli.positionals[1], {
    includeEvents: !!cli.flags["include-events"],
    includeUmids: !!cli.flags["include-umids"],
    dryRun: !!cli.flags["dry-run"],
    yes: !!cli.flags.yes,
    deleteDb: cli.flags["delete-db"],
    noCompact: !!cli.flags["no-compact"],
    json: !!cli.flags.json,
  }).then((code) => process.exit(code));
}
if (cli.command === "project") {
  const f = cli.flags;
  projectCommand(cli.positionals.slice(1), {
    project: f.project as string | undefined,
    net: f.net as string | string[] | undefined,
    dryRun: !!f["dry-run"],
    json: !!f.json,
    yes: !!f.yes,
    quiet: !!f.quiet,
    name: f.name as string | undefined,
    type: f.type as string | undefined,
    fixIgnore: !!f["fix-ignore"],
    allowUnignoredKey: !!f["allow-unignored-key"],
    all: !!f.all,
    set: f.set as string | string[] | undefined,
    noAudit: !!f["no-audit"],
    auditFailOn: f["audit-fail-on"] as string | undefined,
    offline: !!f.offline,
  }).then((code) => process.exit(code));
}
if (cli.command === "audit") {
  auditCommand(cli.positionals[1], {
    json: !!cli.flags.json,
    offline: !!cli.flags.offline,
    failOn: cli.flags["fail-on"] as string | undefined,
    only: cli.flags.only as string | undefined,
    skip: cli.flags.skip as string | undefined,
    rules: !!cli.flags.rules,
  }).then((code) => process.exit(code));
}
if (cli.command === "status") {
  status(!!cli.flags.json).then((code) => process.exit(code));
}

// Do we have an identity (Will always need, Can be shared)
if (cli.command !== "status" && cli.command !== "hybrid" && cli.command !== "prune" && cli.command !== "audit" && cli.command !== "project" && !fs.existsSync("./.identity")) {
  ActiveLogger.info("No Identity found. Generating Identity");
  let identity: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair();
  // 0600: this file contains the node's RSA PRIVATE key - KeyPair.pem is a
  // public field, so JSON.stringify emits it. Without a mode it lands at
  // 0644 under a default umask, readable by every user on the host.
  //
  // Only affects a newly generated identity; an existing .identity keeps
  // whatever permissions it already has, so tightening one that is already
  // on disk is a separate, deliberate step.
  fs.writeFileSync("./.identity", JSON.stringify(withAttestKey(identity.generate())), {
    mode: 0o600,
  });
  ActiveLogger.info("Identity Generated. Continue Boot Cycle");
}

// An identity from before attestation keys gets one added. It does nothing
// until the node's neighbourhood entry lists the public key as `attest`.
if (cli.command !== "status" && cli.command !== "hybrid" && cli.command !== "prune" && cli.command !== "audit" && cli.command !== "project") {
  const added = ensureAttestKey("./.identity");
  if (added?.created) {
    ActiveLogger.info(
      "Attestation key added to the identity. To use it, list this public key as \"attest\": { \"type\": \"ed25519\", \"public\": ... } on this node's neighbourhood entry, then assert the network again:\n" +
        added.public
    );
  }
}

// Quick Testnet builder
if (ActiveOptions.get<boolean>("testnet", false)) {
  CLIHandler.setupTestnet();
} else if (ActiveOptions.get<boolean>("merge", false)) {
  // Merge Configs (Helps Build local net)
  CLIHandler.merge();
} else if (
  cli.command === "status" ||
  cli.command === "check-config" ||
  cli.command === "reload" ||
  cli.command === "prune" ||
  cli.command === "audit" ||
  cli.command === "project" ||
  cli.command === "hybrid"
) {
  // Handled above
} else if (cli.command === "stop") {
  // The unconditional SIGTERM listener below holds the event loop open
  // (a registered process signal handler is a real libuv handle), so
  // this must exit explicitly once done - same reason backup/restore do.
  stopAndWait()
    .then(() => {
      process.exit();
    })
    .catch(() => {
      process.exit();
    });
} else if (cli.command === "restart") {
  if (ActiveOptions.get<boolean>("auto", false)) {
    CLIHandler.restart(true, version);
  } else {
    CLIHandler.restart(false, version);
  }
} else if (ActiveOptions.get<boolean>("stats", false)) {
  CLIHandler.getStats(version);
} else if (ActiveOptions.get<boolean>("backup", false)) {
  CLIHandler.startBackup(ActiveOptions.get<string>("backup", null))
    .then(() => {
      process.exit();
    })
    .catch(() => {
      process.exit();
    });
} else if (ActiveOptions.get<string>("restore", false)) {
  CLIHandler.startRestore(ActiveOptions.get<string>("restore", false))
    .then(() => {
      process.exit();
    })
    .catch(() => {
      process.exit();
    });
} else {
  CLIHandler.start(version);
}

/**
 * Stop the node and wait for it to exit (--timeout seconds, default 30)
 */
async function stopAndWait(): Promise<void> {
  const handler = new PIDHandler();
  await handler.init();
  const pid = (await handler.getPids()).activeledger;
  await CLIHandler.stop();
  if (pid && !(await waitForExit(pid, Number(cli.flags.timeout) || 30))) {
    ActiveLogger.error(`Process ${pid} did not exit in time`);
    process.exitCode = 1;
  }
}

process.on("SIGTERM", async () => {
  process.exit();
});
