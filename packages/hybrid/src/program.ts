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
 * Config keys that can also be given as flags. Registered so the strict
 * unknown-flag check accepts them; `mergeFlags` (config.ts) applies them.
 */
const CONFIG_FLAGS: Cli.CliFlag[] = [
  { name: "upstream", arg: "<host:port[:p2p|http]>", description: "A supernode to follow (repeatable)", group: "Hybrid" },
  { name: "peer", arg: "<host:port[:p2p|http]>", description: "A hybrid peer (repeatable)", group: "Hybrid" },
  { name: "bind", arg: "<addr>", description: "Same as --host", hidden: true },
  { name: "token", arg: "<token>", description: "Bearer token the local API requires", group: "Hybrid" },
  { name: "window-days", arg: "<n>", description: "Days of history to keep", group: "Hybrid" },
  { name: "max-lag-seconds", arg: "<s>", description: "Report 503 beyond this lag (none to clear)", group: "Hybrid" },
  { name: "refuse-onboard", arg: "<true|false>", description: "Refuse default/onboard transactions", group: "Hybrid" },
  { name: "events-contract", arg: "<id>", description: "Pin the events API to this contract (repeatable)", group: "Hybrid" },
  { name: "events-where", arg: "<field:value>", description: "Pin the events API to a payload field (repeatable)", group: "Hybrid" },
  { name: "submit-contract", arg: "<id>", description: "Accept transactions for this contract only (repeatable)", group: "Hybrid" },
  { name: "force", type: "boolean", description: "Overwrite an existing identity or config (init)", group: "Hybrid" },
  { name: "label", arg: "<text>", description: "Label for the registry entry", group: "Registry" },
  { name: "endpoint", arg: "<p2p://host:port>", description: "Endpoint to advertise (repeatable)", group: "Registry" },
  { name: "since", arg: "<time>", description: "Only records since this time (divergences)", group: "Hybrid" },
  { name: "dry-run", type: "boolean", description: "Report what would be done (prune)", group: "Hybrid" },
];

export const hybridProgram = (version: string): Cli.CliProgram => ({
  name: "activehybrid",
  version,
  hollow: true,
  defaultCommand: "start",
  commands: [
    ...Cli.COMMON_COMMANDS.filter((c) => c.name !== "check-config").map((c) =>
      c.name === "status"
        ? { ...c, description: "Print the node's state from its /health. Exit 0 ready, 2 not ready or lagging" }
        : c
    ),
    { name: "check-config", description: "Validate hybrid.json. Exit 2 with the reason if wrong" },
    { name: "init", usage: "[--upstream host:port]...", description: "Create the identity and hybrid.json (refuses to overwrite without --force)" },
    { name: "register", usage: "[--label x] [--endpoint p2p://host:port]...", description: "Register this key on the ledger. Idempotent" },
    { name: "update", usage: "--endpoint ...", description: "Change the advertised endpoints" },
    { name: "retire", description: "Retire this registration (asks for --yes)" },
    { name: "peers", description: "Known hybrid peers" },
    { name: "divergences", usage: "[--since <time>]", description: "List local divergence records" },
    { name: "prune", usage: "[--dry-run]", description: "Run the pruner now" },
    { name: "token", description: "Print a new random bearer token for the config" },
  ],
  flags: [
    ...Cli.COMMON_FLAGS.map((f) => {
      switch (f.name) {
        case "config":
          return { ...f, default: "./hybrid.json" };
        case "port":
          return { ...f, default: "5270" };
        case "host":
          return { ...f, default: "127.0.0.1" };
        default:
          return f;
      }
    }),
    ...CONFIG_FLAGS,
  ],
});
