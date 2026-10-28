# Hybrid nodes

What a hybrid node is, when to run one, and what it does and does not do.
To set one up, go to [Set up and run a hybrid](run.md).

## What a hybrid is

An Activeledger network is run by its supernodes: the nodes that vote on
every transaction and commit the result. A hybrid is a lighter node that
follows those supernodes. It keeps its own copy of the ledger, serves its own
API, and never takes part in the vote.

A hybrid does not take the supernodes' word for anything. For every
transaction it receives it:

1. checks the supernodes' signed votes against the node keys in the network's
   setup stream, and counts them against the network's consensus level;
2. runs the contract itself, on its own copy of the data;
3. compares its result with the outputs the supernodes signed when they
   committed.

If everything matches, the hybrid saves the result. If it does not, the
hybrid repairs its copy from the network and writes a divergence record so you
can see that it happened. See [Operating hybrids](operate.md) for what to do
with those.

A hybrid can also take transactions from your own applications. It votes on
them locally first, and only forwards a transaction it would itself accept to
a supernode. The supernodes still make the final decision.

## When to use one

Run a hybrid when you want:

- your own copy of the ledger data, on your own machine, that you have
  checked rather than trusted;
- a local read API and a local event stream (`GET /events`) for your
  applications, close to where they run;
- a place near your users to submit transactions, with a first check before
  anything reaches the supernodes;
- to support the network without the duty of running a voting node.

Do not run a hybrid when you need:

- a vote. A hybrid adds nothing to consensus. If you need a say in what the
  network commits, run a supernode (see
  [How many nodes](../operate/nodes.md));
- to deploy contracts, claim namespaces or change the network. A hybrid
  refuses to forward those transactions, whoever signs them. Send them to a
  supernode;
- to onboard identities through `default/onboard`. A hybrid refuses those by
  default; the switch is `refuseOnboard` in its config;
- data that is never behind. A hybrid can trail the supernodes. Its `/health`
  reports the lag so a consumer can decide whether to act on what it reads.

## What it needs from the supernodes

- Every supernode on build `40300` or later. From that build supernodes sign
  their votes and their commits, which is what a hybrid checks. See
  [Set up and run a hybrid](run.md).
- Transactions from after the network was asserted at build `40300`, and
  after the last change to the hybrid rules. A hybrid can only run
  contracts, and serve `/umid/` records, from those. A contract deployed
  earlier must be deployed again as a new contract; updating it is not
  enough. This is a known limit of the current release; see
  [Set up and run a hybrid](run.md).
- A `hybrid` section asserted on the ledger. It decides who may register
  (`admission`), which streams every hybrid pulls at start
  (`required`), the history window (`window`) and the oldest hybrid release
  allowed to follow (`minVersion`).
- A registration. The hybrid has its own key, and registers it on the ledger
  through a supernode. Supernodes answer only registered keys.

The supernodes serve hybrids on a set of `/h/*` endpoints next to their normal
API. Every request on them is signed with the hybrid's key.

## What it stores

A hybrid keeps an embedded database in its data directory (`./data` by
default). There is no CouchDB to run.

| Kept | For how long |
|---|---|
| The current state and `:stream` meta of every stream it has seen | Always |
| The transaction record (`:umid` document) each stream currently points at | Always |
| Transaction records for transactions it relayed itself | Always |
| Other transaction records and events | Inside the window (`window.days`, 30 days by default) |
| Contract code, rebuilt from the ledger into `./contracts` | Always |
| Divergence records | Always |

A hybrid learns streams as it needs them. One it does not hold yet is fetched
from the supernodes the first time something asks for it. Older history it has
pruned is fetched again from a supernode on demand and checked against the
supernodes' signatures before it is served.

## What it does not do

- It does not vote and it does not commit on behalf of the network.
- It does not forward contract deploys, namespace claims, setup or fund
  transactions. These are refused before anything else, and the refusal is
  not configurable.
- It does not share volatile data. Volatile is each node's own and never
  leaves the node: the supernodes do not serve it to hybrids, and a hybrid
  does not serve it to anyone.
- It does not let contracts make network calls. A contract that tries is
  blocked, and the hybrid adopts the supernodes' signed result for that
  transaction instead of computing its own. Contract authors can plan for
  this: see [Writing contracts that also run on hybrids](../contracts/hybrid.md).
- It does not retry a forwarded transaction. If no answer comes back in time
  it tells the client, with the transaction's id, so the client can look it
  up before sending again.

## Next

- [Set up and run a hybrid](run.md)
- [Operating hybrids](operate.md)
- [The activehybrid command](../cli/activehybrid.md)
