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
  "nanoGateway",
  "neighbourhood",
  "neighbourhoodRemap",
  "network",
  "p2pStream",
  "p2pStreamServer",
  "proxy",
  "queue_retry",
  "rebaseThrottle",
  "remote",
  "security",
  "winston",
];

export const supernodeProgram = (version: string): Cli.CliProgram => ({
  name: "activeledger",
  version,
  defaultCommand: "start",
  commands: [
    ...Cli.COMMON_COMMANDS,
    { name: "hybrid", usage: "list|feeds|ban <keyhash>|unban <keyhash>|allow <key>|deny <key>|admission <open|allowlist>|min-version <semver>|sign <file>|submit <file>", description: "Manage the hybrids that follow this node" },
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
    { name: "out", arg: "<file>", description: "hybrid allow|deny|admission|min-version: write the signed change to a file instead of sending it", group: "Hybrid" },
    { name: "hybrid-listen", arg: "<port>", description: "Port for the hybrid P2P listener", group: "Hybrid" },
    { name: "hybrid-max-feeds", arg: "<n>", description: "Most hybrid feeds served at once (default 32)", group: "Hybrid" },
    { name: "hybridMaxFeeds", hidden: true, description: "Config key for hybrid-max-feeds" },
    { name: "backup", arg: "[file]", description: "Back up the ledger", group: "Backup" },
    { name: "restore", arg: "<file>", description: "Restore the ledger from a backup", group: "Backup" },
    ...CONFIG_KEYS.map((name) => ({ name, hidden: true, description: "Config key override" })),
  ],
});
