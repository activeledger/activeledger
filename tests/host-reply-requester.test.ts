import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveClone } from "@activeledger/activeutilities";
import { Home } from "../packages/network/src/network/home";
import { Host } from "../packages/network/src/network/host";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";

/**
 * A node that receives a frame with $$noreply=false answers with its own
 * current state. It used to send that answer to every peer; only the node
 * that asked can use it (the others got the same state straight from this
 * node's own broadcast), so it now goes to the asker alone. Anything we
 * cannot identify with confidence still gets the old reply to everybody.
 */
describe("Host answers a consensus request only to the node that asked", () => {
  const SELF = "self-ref";
  const saved: any = {};
  const key = new ActiveCrypto.KeyPair("rsa");
  const keys = key.generate();

  before(() => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    saved.p2pStream = ActiveOptions.get("p2pStream", undefined);
    saved.security = ActiveOptions.get("security", undefined);
    Home.reference = SELF;
    Home.identity = key;
    Maintain.pairNow = () => undefined;
    ActiveOptions.set("security", {});
  });

  after(() => {
    Home.reference = saved.reference;
    Home.identity = saved.identity;
    Maintain.pairNow = saved.pairNow;
    ActiveOptions.set("p2pStream", saved.p2pStream);
    ActiveOptions.set("security", saved.security);
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  interface Peer {
    peer: Neighbour;
    ref: string;
    sent: Buffer[];
    // What the host's broadcasting flag was at the moment each frame was written
    flagAtSend: any[];
    failNext: number;
  }

  // A peer on the P2P path recording the frames it is asked to send
  const makePeer = (port: number, host: () => any): Peer => {
    ActiveOptions.set("p2pStream", false); // no real socket
    const peer = new Neighbour(
      "127.0.0.1",
      port,
      true,
      new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
    );
    ActiveOptions.set("p2pStream", true);
    const rec: Peer = { peer, ref: peer.reference, sent: [], flagAtSend: [], failNext: 0 };
    (peer as any).p2pClient = {
      ready: true,
      send: (data: Buffer) => {
        rec.flagAtSend.push(host()?.processPending?.u1?.broadcasting);
        if (rec.failNext > 0) {
          rec.failNext--;
          throw new Error("write failed");
        }
        rec.sent.push(data);
      },
    };
    return rec;
  };

  const decode = (b: Buffer): Promise<any> => ActiveClone.deserialize(b);

  interface Opts {
    firewall?: (remote: string, ref?: string) => boolean;
    mutate?: (entry: any) => void;
  }

  // Host with SELF plus peers B, C, D. Real pending()/broadcast()/broadcastResolver().
  const makeHost = (base: number, opts: Opts = {}) => {
    let host: any;
    const B = makePeer(base + 1, () => host);
    const C = makePeer(base + 2, () => host);
    const D = makePeer(base + 3, () => host);
    const hood: { [ref: string]: Neighbour } = {};
    [B, C, D].forEach((p) => (hood[p.ref] = p.peer));
    const workerMsgs: any[] = [];
    const entry: any = {
      $umid: "u1",
      $broadcast: true,
      $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
      $nodes: { [SELF]: { vote: true, commit: false } },
    };
    if (opts.mutate) opts.mutate(entry);
    host = Object.assign(Object.create(Host.prototype), {
      reference: SELF,
      processPending: { u1: { entry, pid: 1, finished: false } },
      neighbourhood: {
        get: (ref?: string) => (ref ? hood[ref] : hood),
        keys: () => Object.keys(hood),
        checkFirewall: opts.firewall || (() => true),
      },
      findProcessor: () => ({ send: (m: any) => workerMsgs.push(m) }),
    });
    return { host, B, C, D, entry, workerMsgs };
  };

  // What a peer's worker-triggered broadcast looks like arriving here
  const frameFrom = (ref: string, extra: any = {}) => ({
    $umid: "u1",
    $broadcast: true,
    $$noreply: false,
    $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
    $nodes: { [ref]: { vote: true, commit: false } },
    ...extra,
  });

  const receive = (host: any, frame: any, requester: string | undefined, remote = "10.0.0.2") =>
    (Host.prototype as any).pending.call(host, frame, remote, true, false, true, requester);

  const counts = (...ps: Peer[]) => ps.map((p) => p.sent.length);

  describe("(a) who receives the reply", () => {
    it("a $$noreply=false frame from B gets exactly one knock, to B, and none to the others", async () => {
      const { host, B, C, D } = makeHost(7100);
      await receive(host, frameFrom(B.ref), B.ref);
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([1, 0, 0]);
    });

    it("a $$noreply=true frame causes no reply to anyone", async () => {
      const { host, B, C, D } = makeHost(7110);
      await receive(host, frameFrom(B.ref, { $$noreply: true }), B.ref);
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([0, 0, 0]);
    });

    it("each of two requesters gets its own reply, and nobody else does", async () => {
      const { host, B, C, D } = makeHost(7120);
      await receive(host, frameFrom(B.ref), B.ref);
      await receive(host, frameFrom(C.ref), C.ref);
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([1, 1, 0]);
    });

    it("the answer to the HTTP caller is still the pending entry, untouched", async () => {
      const { host, B, entry } = makeHost(7130);
      const res = await receive(host, frameFrom(B.ref), B.ref);
      expect(res.status).to.equal(200);
      expect(res.data).to.equal(host.processPending.u1.entry);
      expect(res.data).to.equal(entry);
      expect(res.dontRelease).to.equal(true);
    });
  });

  describe("(b) what the reply contains", () => {
    it("is byte-identical to what the reply-to-all path sent B, and decodes to our own state only", async () => {
      const targeted = makeHost(7200);
      await receive(targeted.host, frameFrom(targeted.B.ref), targeted.B.ref);
      await wait(50);

      // The old reply: broadcast(umid, false, true) to everyone, same state
      const old = makeHost(7200);
      (Host.prototype as any).broadcast.call(old.host, "u1", false, true);
      await wait(50);

      expect(targeted.B.sent).to.have.length(1);
      expect(old.B.sent).to.have.length(1);
      expect(targeted.B.sent[0].equals(old.B.sent[0])).to.equal(true);

      const body = await decode(targeted.B.sent[0]);
      expect(body.$$noreply).to.equal(true);
      expect(body.$umid).to.equal("u1");
      expect(body.$nodes).to.deep.equal({ [SELF]: { vote: true, commit: false } });
    });
  });

  describe("(c) a requester we cannot identify gets the old reply to everyone", () => {
    const allThree = async (setup: ReturnType<typeof makeHost>, frame: any, requester: string | undefined) => {
      await receive(setup.host, frame, requester);
      await wait(50);
      expect(counts(setup.B, setup.C, setup.D)).to.deep.equal([1, 1, 1]);
      for (const p of [setup.B, setup.C, setup.D]) {
        const body = await decode(p.sent[0]);
        expect(body.$$noreply).to.equal(true);
      }
    };

    it("no requester supplied", async () => {
      const s = makeHost(7300);
      await allThree(s, frameFrom(s.B.ref), undefined);
    });

    it("the 'NA' placeholder the endpoint uses when there is no header", async () => {
      const s = makeHost(7310);
      await allThree(s, frameFrom(s.B.ref), "NA");
    });

    it("a requester that is not in the neighbourhood", async () => {
      const s = makeHost(7320);
      await allThree(s, frameFrom("stranger"), "stranger");
    });

    it("a requester that is this node itself", async () => {
      const s = makeHost(7330);
      await allThree(s, frameFrom(SELF), SELF);
    });

    it("a requester that is a known peer but not home", async () => {
      const s = makeHost(7340);
      s.B.peer.isHome = false;
      await receive(s.host, frameFrom(s.B.ref), s.B.ref);
      await wait(50);
      // The old path never sent to a peer that is down, and still does not
      expect(counts(s.B, s.C, s.D)).to.deep.equal([0, 1, 1]);
    });

    it("a header that says B while the payload's $nodes says C (spoof)", async () => {
      const s = makeHost(7350);
      await allThree(s, frameFrom(s.C.ref), s.B.ref);
    });

    it("a payload carrying several nodes (not a peer's own broadcast)", async () => {
      const s = makeHost(7360);
      const frame = frameFrom(s.B.ref, {
        $nodes: { [s.B.ref]: { vote: true }, [s.C.ref]: { vote: true } },
      });
      await allThree(s, frame, s.B.ref);
    });

    it("a payload with no $nodes (early placeholder rebroadcast)", async () => {
      const s = makeHost(7370);
      await allThree(s, frameFrom(s.B.ref, { $nodes: {} }), s.B.ref);
    });

    it("a requester that fails the firewall check from this address is refused outright, with no reply at all", async () => {
      const s = makeHost(7380, { firewall: (_remote, ref) => ref === undefined });
      const rejected = await receive(s.host, frameFrom(s.B.ref), s.B.ref).catch((e: any) => e);
      expect(rejected).to.equal("Bad Neighbour Payload");
      await wait(50);
      expect(counts(s.B, s.C, s.D)).to.deep.equal([0, 0, 0]);
    });
  });

  describe("(d) everything else still goes to everybody", () => {
    it("a worker-triggered broadcast goes to every peer with $$noreply=false", async () => {
      const { host, B, C, D } = makeHost(7400);
      (Host.prototype as any).broadcast.call(host, "u1");
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([1, 1, 1]);
      for (const p of [B, C, D]) {
        expect((await decode(p.sent[0])).$$noreply).to.equal(false);
      }
    });

    it("an early placeholder goes to every peer with $$noreply=true and empty $nodes", async () => {
      const { host, B, C, D } = makeHost(7410, {
        mutate: (e) => (e.$nodes = {}),
      });
      (Host.prototype as any).broadcast.call(host, "u1", true);
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([1, 1, 1]);
      const body = await decode(B.sent[0]);
      expect(body.$$noreply).to.equal(true);
      expect(body.$nodes).to.deep.equal({});
    });

    it("a failed knock still rebroadcasts to everyone after 250ms", async () => {
      const { host, B, C, D } = makeHost(7420);
      C.failNext = 1;
      (Host.prototype as any).broadcast.call(host, "u1");
      await wait(100);
      // First attempt: C's write failed, B and D got theirs
      expect(counts(B, C, D)).to.deep.equal([1, 0, 1]);
      await wait(350);
      expect(counts(B, C, D)).to.deep.equal([2, 1, 2]);
      expect((await decode(C.sent[0])).$$noreply).to.equal(false);
    });

    it("a reply whose knock fails still triggers the 250ms rebroadcast to everyone", async () => {
      const { host, B, C, D } = makeHost(7430);
      B.failNext = 1;
      await receive(host, frameFrom(B.ref), B.ref);
      await wait(100);
      expect(counts(B, C, D)).to.deep.equal([0, 0, 0]);
      await wait(350);
      // The rebroadcast is the normal one: all peers, $$noreply=false
      expect(counts(B, C, D)).to.deep.equal([1, 1, 1]);
      expect((await decode(C.sent[0])).$$noreply).to.equal(false);
    });
  });

  describe("(e) the broadcasting gate", () => {
    it("drops the reply while a broadcast is in flight and leaves the flag alone", async () => {
      const { host, B, C, D } = makeHost(7500);
      host.processPending.u1.broadcasting = true;
      await receive(host, frameFrom(B.ref), B.ref);
      await wait(50);
      expect(counts(B, C, D)).to.deep.equal([0, 0, 0]);
      expect(host.processPending.u1.broadcasting).to.equal(true);
    });

    it("the reply does not take the flag, so it cannot hold up a worker broadcast", async () => {
      const { host, B, C, D } = makeHost(7510);
      await receive(host, frameFrom(B.ref), B.ref);
      await wait(50);
      expect(B.flagAtSend[0]).to.not.equal(true);
      expect(host.processPending.u1.broadcasting).to.not.equal(true);

      // A worker broadcast issued while a reply is still in flight goes out
      const s = makeHost(7515);
      await receive(s.host, frameFrom(s.B.ref), s.B.ref);
      (Host.prototype as any).broadcast.call(s.host, "u1");
      await wait(50);
      expect(counts(s.B, s.C, s.D)).to.deep.equal([2, 1, 1]);
      expect(s.host.processPending.u1.broadcasting).to.equal(false);
      void C;
      void D;
    });

    it("a reply completing while a worker broadcast is still in flight does not clear the flag", async () => {
      const s = makeHost(7520);
      // D never answers the worker broadcast until we say so
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      (s.D.peer as any).knock = () => gate;

      (Host.prototype as any).broadcast.call(s.host, "u1");
      expect(s.host.processPending.u1.broadcasting).to.equal(true);

      // The reply arrives mid-flight: dropped, as before
      await receive(s.host, frameFrom(s.B.ref), s.B.ref);
      await wait(50);
      expect(s.host.processPending.u1.broadcasting).to.equal(true);
      // only the worker broadcast's frames to B and C
      expect(counts(s.B, s.C)).to.deep.equal([1, 1]);

      release();
      await wait(20);
      expect(s.host.processPending.u1.broadcasting).to.equal(false);
    });

    it("a reply sent just before a worker broadcast starts does not clear that broadcast's flag when it completes", async () => {
      const s = makeHost(7530);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));

      await receive(s.host, frameFrom(s.B.ref), s.B.ref);
      // Reply to B is in flight; now a worker broadcast whose D hangs
      (s.D.peer as any).knock = () => gate;
      (Host.prototype as any).broadcast.call(s.host, "u1");
      await wait(50); // the reply has completed by now
      expect(s.B.sent.length).to.equal(2);
      expect(s.host.processPending.u1.broadcasting).to.equal(true);
      release();
      await wait(20);
      expect(s.host.processPending.u1.broadcasting).to.equal(false);
    });
  });

  describe("(f) four nodes still converge when a direct frame is lost", () => {
    interface Node {
      ref: string;
      host: any;
      seen: { [ref: string]: { vote?: boolean; commit?: boolean } };
      peers: { [ref: string]: Neighbour };
      committed: boolean;
    }

    // Four hosts wired in memory. Real pending()/broadcast()/broadcastResolver()
    // per node; the protocol worker is a minimal stand-in: vote, commit once
    // all four votes are known, done once all four commits are known.
    const build = (base: number, drop: (from: string, to: string, body: any) => "drop" | "fail" | undefined) => {
      const nodes: { [ref: string]: Node } = {};
      const refs = ["n0", "n1", "n2", "n3"];
      const wire: { [ref: string]: { [to: string]: Neighbour } } = {};

      // Neighbour references derive from a hash; map our names onto them
      const peerRefOf: { [name: string]: string } = {};
      const probes: { [name: string]: Neighbour } = {};
      refs.forEach((r, i) => {
        ActiveOptions.set("p2pStream", false);
        probes[r] = new Neighbour("127.0.0.1", base + i * 10, true, new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem));
        ActiveOptions.set("p2pStream", true);
        peerRefOf[r] = probes[r].reference;
      });
      const nameOf: { [ref: string]: string } = {};
      refs.forEach((r) => (nameOf[peerRefOf[r]] = r));

      refs.forEach((r) => {
        const peers: { [ref: string]: Neighbour } = {};
        refs.filter((o) => o !== r).forEach((o) => {
          ActiveOptions.set("p2pStream", false);
          const p = new Neighbour("127.0.0.1", base + refs.indexOf(o) * 10, true, new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem));
          ActiveOptions.set("p2pStream", true);
          peers[p.reference] = p;
        });
        wire[r] = peers;
      });

      refs.forEach((r) => {
        const self = peerRefOf[r];
        const node: Node = { ref: self, host: undefined, seen: {}, peers: wire[r], committed: false };
        const entry: any = {
          $umid: "u1",
          $broadcast: true,
          $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
          $nodes: {},
        };
        const advance = () => {
          const all = refs.map((o) => node.seen[peerRefOf[o]]);
          if (!node.seen[self]?.commit && all.every((s) => s?.vote)) {
            node.seen[self] = { vote: true, commit: true };
            entry.$nodes = { [self]: { vote: true, commit: true } };
            (Host.prototype as any).broadcast.call(node.host, "u1");
          }
          if (all.every((s) => s?.commit)) node.committed = true;
        };
        const worker = {
          send: (m: any) => {
            if (m.type !== "broadcast") return;
            for (const k of Object.keys(m.data.nodes)) {
              node.seen[k] = { ...node.seen[k], ...m.data.nodes[k] };
            }
            advance();
          },
        };
        node.host = Object.assign(Object.create(Host.prototype), {
          reference: self,
          processPending: { u1: { entry, pid: 1, finished: false } },
          neighbourhood: {
            get: (ref?: string) => (ref ? node.peers[ref] : node.peers),
            keys: () => Object.keys(node.peers),
            checkFirewall: () => true,
          },
          findProcessor: () => worker,
        });
        // Delivery: frame -> the receiving node's pending(), as the P2P socket handler does
        Object.values(node.peers).forEach((p) => {
          (p as any).p2pClient = {
            ready: true,
            send: (data: Buffer) => {
              // On the real wire the header carries the sender's own reference
              const senderRef = self;
              const to = nameOf[p.reference];
              (async () => {
                const body = await decode(data);
                const verdict = drop(nameOf[senderRef] || senderRef, to, body);
                if (verdict) return;
                setImmediate(() => {
                  (Host.prototype as any).pending
                    .call(nodes[to].host, body, "127.0.0.1", true, false, true, senderRef)
                    .catch(() => undefined);
                });
              })();
            },
          };
        });
        // Frames carry Home.reference as the sender
        nodes[r] = node;
        entry.$nodes = { [self]: { vote: true, commit: false } };
        node.seen[self] = { vote: true, commit: false };
      });

      const start = () => {
        refs.forEach((r) => (Host.prototype as any).broadcast.call(nodes[r].host, "u1"));
      };
      return { nodes, refs, start, peerRefOf, nameOf };
    };

    const allCommitted = (nodes: { [r: string]: Node }) =>
      Object.values(nodes).every((n) => n.committed);

    const converge = async (nodes: { [r: string]: Node }, ms = 3000) => {
      const end = Date.now() + ms;
      while (!allCommitted(nodes) && Date.now() < end) await wait(10);
    };

    it("commits everywhere with no loss (baseline)", async () => {
      const net = build(7600, () => undefined);
      net.start();
      await converge(net.nodes);
      expect(allCommitted(net.nodes)).to.equal(true);
    });

    it("commits everywhere when n0's direct commit frame to n1 is silently lost", async () => {
      let dropped = 0;
      const net = build(7700, (_from, to, body) => {
        const only = Object.keys(body.$nodes || {});
        if (to === "n1" && only.length === 1 && only[0] === net.peerRefOf.n0 && body.$nodes[only[0]].commit && !dropped) {
          dropped++;
          return "drop";
        }
        return undefined;
      });
      net.start();
      await converge(net.nodes);
      expect(dropped).to.equal(1);
      expect(allCommitted(net.nodes)).to.equal(true);
    });

    it("commits everywhere when n0's commit frame to n1 fails to send, via the rebroadcast timer", async () => {
      let failed = 0;
      const net = build(7800, () => undefined);
      // Make n0's write to n1 throw once, for the commit frame
      const n0 = net.nodes.n0;
      const toN1 = Object.values(n0.peers).find((p) => p.reference === net.peerRefOf.n1) as any;
      const realSend = toN1.p2pClient.send;
      toN1.p2pClient.send = (data: Buffer, ref: string) => {
        // Peek the frame cheaply: the state it carries is the commit when n0's entry says so
        if (n0.seen[n0.ref]?.commit && !failed) {
          failed++;
          throw new Error("connection reset");
        }
        return realSend(data, ref);
      };
      net.start();
      await converge(net.nodes, 4000);
      expect(failed).to.equal(1);
      expect(allCommitted(net.nodes)).to.equal(true);
    });
  });
});
