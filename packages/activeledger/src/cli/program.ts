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

import { Cli } from "@activeledger/activeoptions";

/**
 * Config keys the code reads through ActiveOptions.get, which a flag may
 * override. Registered so they stay valid, but left out of help.
 */
const CONFIG_KEYS = [
  "autostart",
  "build",
  "configVersion",
  "consensus",
  "contractCheckTimeout",
  "contractMaxTimeout",
  "cpus",
  "db",
  "debugToClient",
  "gzip",
  "max_memory",
  "neighbourhood",
  "neighbourhoodRemap",
  "network",
  "p2pQuietReplies",
  "p2pResendMs",
  "p2pSlimReplies",
  "p2pStream",
  "p2pStreamServer",
  "proxy",
  "queue_retry",
  "rebaseThrottle",
  "releaseHoldSeconds",
  "releaseStubSeconds",
  "releaseTailSeconds",
  "remote",
  "security",
  "worker_semi_space",
];

export const supernodeProgram = (version: string): Cli.CliProgram => ({
  name: "activeledger",
  version,
  defaultCommand: "start",
  commands: [
    ...Cli.COMMON_COMMANDS,
    { name: "reload", description: "Make the running node re-read config.json (needs \"remote\": true)" },
    { name: "prune", usage: "[days]", description: "Remove old errors (and, if asked, old events and umids) from this node's stores, keeping the last [days] days (default 30). Never touches the ledger" },
    { name: "audit", usage: "<file|folder>", description: "Check contract source for security problems, bad practice, duplicate code and risky dependencies, and print a risk score. Changes nothing" },
    { name: "hybrid", usage: "status|enable [open|allowlist]|list|feeds|ban <keyhash>|unban <keyhash>|allow <key>|deny <key>|admission <open|allowlist>|min-version <semver>|sign <file>|submit <file>", description: "Manage the hybrids that follow this node" },
  ],
  flags: [
    ...Cli.COMMON_FLAGS.map((f) =>
      f.name === "config" ? { ...f, default: "./config.json" } : f
    ),
    ...(
      [
        ["stop", "Stop the node", "stop", "boolean"],
        ["restart", "Restart the node", "restart", "boolean"],
        ["auto", "Mark a restart as automatic", undefined, "boolean"],
        ["stats", "Print node statistics", undefined, "boolean"],
      ] as const
    ).map(([name, description, command, type]) => ({
      name,
      description,
      command,
      type,
      group: "Legacy actions",
    })),
    { name: "testnet", description: "Build a local test network", group: "Setup" },
    { name: "merge", description: "Merge configs to build a local network", group: "Setup" },
    { name: "assert", description: "Assert the config on-ledger", group: "Setup" },
    { name: "assert-network", description: "Assert the config as a network", group: "Setup" },
    { name: "sign", arg: "<file>", description: "Sign the asserted config", group: "Setup" },
    { name: "public", description: "Print the node's public key", group: "Setup" },
    { name: "setup-only", description: "Run setup then exit", group: "Setup" },
    { name: "db-only", description: "Start only the database", group: "Setup" },
    { name: "disable-autostart", description: "Do not start the helper processes", group: "Setup" },
    { name: "include-umids", type: "boolean", description: "prune: also remove old umid index rows (umid: and fail:) from the events database", group: "Prune" },
    { name: "include-events", type: "boolean", description: "prune: also remove old contract events from the events database", group: "Prune" },
    { name: "dry-run", type: "boolean", description: "prune: say what would be removed and remove nothing", group: "Prune" },
    { name: "delete-db", arg: "<name>", description: "prune: delete this whole database (other than the node's own); repeat for more", group: "Prune" },
    { name: "no-compact", type: "boolean", description: "prune: do not compact after removing, so the disk space is not given back yet", group: "Prune" },
    { name: "offline", type: "boolean", description: "audit: do not look dependencies up in the npm advisory database", group: "Audit" },
    { name: "fail-on", arg: "<severity>", description: "audit: exit 1 when a finding is at or above critical, high, medium or low", group: "Audit" },
    { name: "only", arg: "<rules>", description: "audit: run only these rule ids, comma separated", group: "Audit" },
    { name: "skip", arg: "<rules>", description: "audit: leave out these rule ids, comma separated", group: "Audit" },
    { name: "rules", type: "boolean", description: "audit: list the rules and exit", group: "Audit" },
    { name: "out", arg: "<file>", description: "hybrid allow|deny|admission|min-version: write the signed change to a file instead of sending it", group: "Hybrid" },
    { name: "hybrid-listen", arg: "<port>", description: "Port for the hybrid P2P listener", group: "Hybrid" },
    { name: "hybrid-max-feeds", arg: "<n>", description: "Most hybrid feeds served at once (default 32)", group: "Hybrid" },
    { name: "hybridMaxFeeds", hidden: true, description: "Config key for hybrid-max-feeds" },
    { name: "backup", arg: "[file]", description: "Back up the ledger", group: "Backup" },
    { name: "restore", arg: "<file>", description: "Restore the ledger from a backup", group: "Backup" },
    ...CONFIG_KEYS.map((name) => ({ name, hidden: true, description: "Config key override" })),
  ],
});
