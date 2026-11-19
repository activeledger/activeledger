# Neighbourhood and pairing redesign

Status: draft for review · 2026-11-19

## Goal

Make a node find its neighbours quickly, know exactly why one is not
usable, and never lose a transaction in the gap between "a neighbour is
up" and "this node has noticed". Give the handshake room for what later
work needs (chain id, build, version, capabilities) without more
one-off headers.

Not in scope: the consensus protocol, the P2P frame format, SPI, and how
votes are tallied. Nothing here changes what a vote means, so no `build`
gate is needed for the first phases.

## How it works today

Read from `packages/network/src/network/` on master (5.7.1).

- **Membership** is the `neighbourhood` list in the node config (host,
  port, identity public key), replaced from the ledger's network stream
  by `extendConfig` and by a config reload. `Neighbourhood` holds one
  `Neighbour` per entry, keyed by a reference: `sha1(host + port +
  network)`. A reload marks every existing neighbour `graceStop`, then
  adds the new list.
- **Discovery** is polling. `Maintain.healthTimer` runs
  `checkNeighbourhood` every 300 ms until every configured neighbour is
  `isHome` or `graceStop`, then stops for good. `checkNeighbourhood`
  does `knock("status")` (an HTTP GET carrying `X-Activeledger:
  <reference>`) to each neighbour; any answer that is not "request
  failed" marks it `isHome`.
- **The answer to a status knock** is 200 if the sender's reference is in
  the receiver's neighbourhood and not leaving, otherwise 403. There is
  no signature and no firewall check on this route (the other `/a/*`
  routes use `firewallCheck`). `ActiveRequest.send` resolves only the
  parsed body, never the status code, so a knock cannot tell 200 from
  403; a body of `{}` counts as success.
- **Ordering and ring.** `Maintain.pairing` sorts neighbours by reference
  and picks the next `isHome` neighbour to the left and right, which
  become `Home.left` and `Home.right`. Most traffic is a broadcast to
  every `isHome` neighbour; the ring is still used to forward a
  non-broadcast `init` to `Home.right`.
- **After discovery**, health is reactive: a failed knock calls
  `markUnavailable`, which clears `isHome`, re-pairs, and starts a 3 s
  recovery poll for just that neighbour.
- **Node status** (`Unrecognised`, `Pairing`, `Recognised`, `Unstable`,
  `Stable`) is derived from left/right only. `Stable` means "left and
  right are found", not "every neighbour is found".

## Problems

1. **A broadcast skips a neighbour that is not yet `isHome`, and nothing
   resends to it.** `Host.broadcast` only sends to `isHome` nodes, and the
   resend timer (`armResend`) only chases nodes that were `isHome` and
   then went silent. A transaction sent while a neighbour is up but not
   yet noticed never reaches it; SPI repairs the state later, but the
   neighbour meanwhile answers "Stream(s) not found" and "Namespace not
   found". Confirmed from node logs on 2026-11-17 (a node is `Stable`
   before it has found every neighbour). The test harness works around it
   by waiting for the "Neighbourhood fully discovered" line; the product
   does not.
2. **Discovery is one-sided.** A node learns a neighbour is up only by
   knocking it. When a neighbour knocks us first we already know it is
   alive, and we do not use that.
3. **A refusal looks like a success.** Because only the body comes back, a
   neighbour that refuses us (403, or since 5.7.1 a chain mismatch) can only
   be signalled through a special body that this one caller knows about.
   There is no general way to say "unreachable", "not in your
   neighbourhood", "wrong network", "wrong chain" or "build too low" and have
   the operator see which.
4. **The status route is unauthenticated** apart from knowing a reference,
   which is a hash of public values. Harmless today because it reveals
   little, but it means "a neighbour answered" proves very little.
5. **Exchanged facts are bolted on.** The 5.7.0 chain id went in as a
   header on the status knock. Build, version and which optional features
   a peer supports (`p2pStream`, slim and quiet replies) are learned other
   ways or assumed.
6. **Discovery polls everyone, forever, while any neighbour is missing.**
   `healthTimer` re-arms every 300 ms until all neighbours are home, and
   each tick `checkNeighbourhood` knocks *every* neighbour, including the
   ones already home. With one node down for a long time, every other node
   sends a status knock to every neighbour four times a second for as long as
   it stays down. Read from the code, not measured; the first measurement to
   take is status knocks per minute on a four-node network with one node
   stopped. The same code also never uses what the P2P layer already knows:
   `P2PClient` has connect and close events and reconnects every 2 s on its
   own.
7. **The pairing logic is only tested live.** It is a set of static fields
   on `Maintain`, timers and HTTP calls, so a start-up ordering bug needs a
   multi-node run to see (the soak of 443 staggered starts found the
   first-transaction timeout at about 5% and persistent lag at 1-2%).

## Proposal

### 1. A hello exchange

Replace "status knock plus special cases" with one versioned exchange per
neighbour: `GET /a/hello` (the status route stays, answering as today, for
older nodes).

The request carries the sender's reference (as now). The response is a
small signed object:

```json
{
  "hello": 1,
  "reference": "<responder reference>",
  "chain": 5,
  "version": "5.8.0",
  "build": 50700,
  "ready": true,
  "knows": true,
  "features": ["p2pStream", "slimReplies", "quietReplies"]
}
```

- `knows` says whether the responder has the sender in its neighbourhood
  (today's 200 against 403).
- `ready` is "my neighbourhood is loaded", so a node that is listening but
  still booting is not mistaken for a node that refuses us.
- Signed with the node identity, verified against the public key already in
  the neighbourhood entry. This closes problem 4 without a new key.
- Unknown fields are ignored, so it can grow.

### 2. A reason for every non-home neighbour

Each `Neighbour` carries a state and a reason instead of only `isHome`:

| State | Reason | Becomes home? |
|---|---|---|
| `unreachable` | no answer | retry with backoff |
| `booting` | answered, `ready: false` | retry |
| `refused` | `knows: false` (not in their neighbourhood) | retry slowly |
| `mismatch` | different chain or network | no, until config changes |
| `outdated` | build or version below what the network requires | no |
| `home` | hello ok | yes |

`isHome` stays as a derived getter (`state === "home"`), so nothing that
reads it changes. The reason is logged once per change and shown in the
node status (`/a/status` already lists neighbours and `isHome`), so an
operator sees why a node never becomes ready.

### 3. Liveness from connections and traffic, not polling

Stop asking "are you there?" on a timer. A neighbour is known to be up from
things this node already sees:

- **The P2P connection.** `P2PClient` emits connect and close. A connect to a
  configured neighbour starts one hello (section 1); a close marks it
  `unreachable` and the client's own 2 s reconnect brings it back. Inbound P2P
  connections count the same way.
- **Any answer or message from a neighbour.** A vote, a reply or a frame from
  a configured neighbour means it is up. `Host.heardFrom` already tracks this
  per transaction; the same fact updates the neighbour's last-heard time.
- **A failed send.** Already how a neighbour is marked down
  (`markUnavailable`); it stays.
- **An inbound hello or status knock** from a configured neighbour: it is up,
  so hello it back at once.

No periodic status knock in steady state (already true after discovery) and
none during discovery either. Two cases still need a timer, both with backoff
and jitter, not a fixed 300 ms: a neighbour on HTTP only (`p2pStream` off),
and a neighbour with no P2P connection yet (the client gives up retrying a
never-connected peer after ten minutes, so something must still find it
later). An idle network has no traffic to learn from; the P2P connection state
covers it, and a TCP keepalive on that socket is the heartbeat if one is
needed.

Expected effect: no knock storm while a node is down, a faster start (a
neighbour is found when its socket connects, not on the next poll), and less
load on the host process during start-up. To be measured, not assumed.

### 4. No gap between "up" and "noticed"

When a neighbour becomes `home`, every transaction still pending on this node
(`processPending`, not finished) is sent to it once, the way `armResend`
already sends to silent nodes. `armResend`'s candidate list widens from "was
home, now silent" to "configured, not yet home".

Chosen over only widening the resend because the resend is bounded (five
tries from 250 ms, doubling, about 8 s in all), so a neighbour that comes up
30 s late is missed, while replay on becoming home has no timeout.

What replay does not cover: a transaction already committed before the
neighbour was noticed is no longer pending. SPI and restore repair that today
(the neighbour answers "Stream(s) not found" until they do). Whether to add a
catch-up when a neighbour becomes home, for example asking restore to check
recent umids, is open and should be decided from the soak numbers.

### Ready means quorum, complete means everyone

`Stable` today means left and right are found. Replace the readiness test
with: this node plus its home neighbours reaches what `consensus.reached`
needs, since below that the node cannot commit anything. Keep a second
signal, `complete`, for every configured neighbour found. The "Neighbourhood
fully discovered" log and the test harness's wait use `complete`; the start-up
display's "ready" and acceptance of transactions use quorum. Waiting for
everyone would mean one permanently down node keeps the network from ever
reporting ready. To check before building: whether the consensus percentage
is taken over the configured neighbourhood or over the nodes currently up.

### 5. The state machine as its own module

Pull the per-neighbour state, backoff and pairing choice out of the static
`Maintain` into a class that takes an injected transport and clock. Unit
tests can then play out a staggered start deterministically (A up, B up
late, C refuses, D wrong chain) with a fake clock, which is today's missing
coverage (problem 6). `Maintain` becomes a thin caller.

## Compatibility

- **Rolling upgrade.** A node asks for `hello` first; a 404 or an answer in
  the old shape means an older peer, and the node falls back to the status
  knock and its header. An older node asking a newer one gets today's
  status answer. No flag day, no config change.
- **Build gating.** None of this changes a vote or stored data, so it needs
  no `build`. Behaviour that depends on a peer's `features` is guarded by
  what the peer reports, never assumed.
- **What stays:** the reference derivation, ordering and left/right, the
  `Neighbourhood` list and reload semantics, `graceStop`, the firewall by
  address on the other routes.

## Multi-chain

The hello carries `chain`, which replaces the 5.7 header (kept for
fallback). A node that later takes part in more than one chain (see
`2026-11-19-multi-chain.md`) holds one `Neighbourhood` per chain it is a
member of, each paired separately; a follower uses `upstreams` and has no
neighbourhood. The state machine in section 5 is written per chain from the
start so that is a second instance, not a rewrite.

## Phases

1. State and reason on `Neighbour`, logged and shown in `/a/status`. No
   protocol change.
2. The deterministic state machine and its tests (no behaviour change).
3. Pending transactions sent when a neighbour becomes home (problem 1).
4. `hello`, signed, with the fallback.
5. Liveness from connections and traffic, polling removed, with backoff for
   the cases that still need a timer.
6. Per-chain neighbourhoods, when multi-chain needs them.

Phases 1-3 fix the known failure and add the tests, and can ship before any
protocol change.

## Tests

- Unit: the state machine under a fake clock and transport (staggered
  start, refusal, mismatch, outdated, recovery, reload during discovery).
- Unit: the replay on becoming home (a transaction sent while a neighbour is
  `booting` reaches it once it is `home`; nothing is sent twice).
- Live (`tests/network`): start four nodes staggered and send a transaction
  as soon as the first reports `Stable`, expecting all four to commit with
  no SPI; a node that is mid-boot; the chain-mismatch case already in
  `chain-live.ts`.
- Soak: the staggered cold-start soak (443 runs before) repeated. The
  numbers to beat are the first-transaction timeout (about 5%) and the
  persistent lag (1-2%).

## Open questions

- Whether a catch-up (restore checking recent umids) should run when a
  neighbour becomes home, beyond replaying pending transactions. Decide from
  the soak.
- How the consensus percentage is counted (configured neighbourhood or nodes
  currently up), which decides what "quorum ready" means. Check in
  `Process` before building.
- What authenticates the sender of a P2P frame. The frame header carries a
  40-character sender reference, which is a claim; treating inbound traffic
  as proof of life must use only checks that already hold (the firewall
  check by address, applied when the frame is processed). Verify.
- The ten-minute limit on P2P reconnection for a never-connected peer: keep,
  lengthen, or replace with the backoff timer above.
- Whether the ring (left/right) is still worth keeping. It is used to
  forward non-broadcast `init`; removing it is a separate change and is not
  proposed here.
- Whether `hello` should be reachable by non-neighbours (a limited form for a
  load balancer or monitor) or only by configured neighbours.
- How a node learns a neighbour's required build, so `outdated` is more than
  a local comparison.

## Baseline (measured 2026-11-19, 5.7.1)

Four nodes on one machine (the `tests/network` harness), status knocks
counted at the receiving node over 60 s windows:

| Situation | Status knocks received, per node, 60 s | Network total |
|---|---|---|
| All four up, discovery finished | 0, 0, 0, 0 | 0 |
| One node never started (the other three restarted while it was down) | 600, 600, 600 | 1,800 (30 a second) |

- With everything up, discovery already stops and steady state costs nothing.
  Polling is only a cost while a neighbour is missing.
- With one neighbour missing, each node receives 10 knocks a second. That is
  three senders at 3.3 a second each, which is the 300 ms tick knocking every
  entry in `neighbourOrder`: both other nodes, the node itself (it is in its
  own order), and the missing node (those knocks fail and are not counted
  here). It continued for the whole 65 s window; the code has no end to it
  while a node is missing.
- A restarted node reported ready (status 4) about 2.7 s after the process
  started, with a neighbour still missing, so `Stable` does not wait for it.

Not measured yet: CPU cost of that polling, time from start to `complete`
for staggered starts, and the soak rates (first-transaction timeout about 5%,
persistent lag 1-2% on the earlier 443-run soak). The counting needs a
temporary log line in the status handler, so the script is not committed;
a counter exposed in `/a/status` would make it repeatable and is a candidate
for phase 1.

## Measurements to take first

On a four-node network on one machine: status knocks per minute (done, see
above); time from process start to ready (quorum) and
to complete, for staggered starts; and the soak (first-transaction timeouts
about 5%, persistent lag 1-2% before). The same numbers after each phase show
whether it helped.
