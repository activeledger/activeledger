import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";
import { Maintain } from "../packages/network/src/network/maintain";

// Endpoints.ExternalInitalise / InternalInitalise / status / all / umid /
// postConvertor against a Host that only has what they call: pending(),
// release(), the neighbourhood and the databases. The processor side is
// covered by the process tests; here the contract is what the client (or the
// neighbour) is told.
describe("Endpoints transaction submission (Activeledger)", () => {
  const realRef = Home.reference;
  const realHost = Home.host;
  const realLeft = Home.left;
  const realRight = Home.right;
  const realPem = Home.publicPem;

  beforeEach(() => {
    Home.reference = "me";
    Home.host = "10.0.0.1:5260";
  });
  afterEach(() => {
    Home.reference = realRef;
    Home.host = realHost;
    Home.left = realLeft;
    Home.right = realRight;
    Home.publicPem = realPem;
  });

  const tx = (over: any = {}): any => ({
    $tx: {
      $namespace: "default",
      $contract: "contract-id",
      $i: { signer: { publicKey: "k" } },
    },
    $sigs: { signer: "sig" },
    ...over,
  });

  interface Script {
    // One entry per call to pending()
    replies: (() => Promise<any>)[];
  }

  const makeHost = (script: Script, over: any = {}) => {
    const pendingCalls: any[] = [];
    const released: any[] = [];
    const host: any = {
      reference: "me",
      pending: (entry: any, remote: string, ...rest: any[]) => {
        pendingCalls.push({
          // The entry is mutated between retries so keep what it looked like
          entry: JSON.parse(JSON.stringify(entry)),
          live: entry,
          remote,
          rest,
        });
        const next = script.replies.shift();
        if (!next) throw new Error("unexpected extra pending() call");
        return next();
      },
      release: (...a: any[]) => released.push(a),
      neighbourhood: { get: () => ({}), keys: () => [], count: () => 3 },
      ...over,
    };
    return { host, pendingCalls, released };
  };

  const voted = (nodes: any, extra: any = {}) => () =>
    Promise.resolve({ status: 200, data: { $umid: "u", $nodes: nodes, ...extra } });

  const db = (exists = false): any => ({ exists: async () => exists });

  describe("ExternalInitalise", () => {
    it("rejects something that is not a transaction with 500", async () => {
      const { host } = makeHost({ replies: [] });
      for (const body of [undefined, null, {}, { $tx: {} }, { $tx: { $i: {} } }]) {
        let caught: any;
        await Endpoints.ExternalInitalise(host, body, "1.2.3.4", db()).catch(
          (e: any) => (caught = e)
        );
        expect(caught, JSON.stringify(body)).to.deep.equal({
          statusCode: 500,
          content: "Invalid Transaction",
        });
      }
    });

    const failure = (error: string) => ({
      statusCode: 200,
      content: {
        $umid: "",
        $summary: { total: 1, vote: 0, commit: 0, errors: [error], counter: 0 },
        $streams: { new: [], updated: [] },
      },
    });

    it("refuses a preset $datetime without sending the transaction on", async () => {
      const { host, pendingCalls } = makeHost({ replies: [] });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $datetime: "2020-01-01" }),
        "1.2.3.4",
        db()
      );
      expect(reply).to.deep.equal(failure("$datetime cannot be preset"));
      expect(pendingCalls).to.have.length(0);
    });

    it("reports an expired transaction as a failure inside a 200", async () => {
      const { host } = makeHost({ replies: [] });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $tx: { ...tx().$tx, $expire: "2001-01-01T00:00:00.000Z" } }),
        "1.2.3.4",
        db()
      );
      expect(reply.statusCode).to.equal(200);
      expect(reply.content.$summary.errors[0]).to.equal(
        "Transaction Expired : 2001-01-01T00:00:00.000Z"
      );
    });

    it("reports a transaction that is already in the ledger, naming its umid", async () => {
      const { host, pendingCalls } = makeHost({ replies: [] });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $tx: { ...tx().$tx, $expire: "2999-01-01T00:00:00.000Z" } }),
        "1.2.3.4",
        db(true)
      );
      expect(reply.content.$summary.errors[0]).to.match(
        /^Transaction Exists : [0-9a-f]{64}$/
      );
      expect(pendingCalls).to.have.length(0);
    });

    it("needs signatures", async () => {
      const { host } = makeHost({ replies: [] });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $sigs: undefined }),
        "1.2.3.4",
        db()
      );
      expect(reply.content.$summary.errors).to.deep.equal(["$sigs not found"]);
    });

    it("stamps origin, address, time, umid and broadcast before handing it to the node", async () => {
      const { host, pendingCalls, released } = makeHost({
        replies: [
          voted({
            me: { vote: true, commit: true },
            b: { vote: true, commit: true, return: { hello: "world" } },
          }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx(),
        "1.2.3.4",
        db()
      );

      const sent = pendingCalls[0].entry;
      expect(sent.$origin).to.equal("me");
      expect(sent.$remoteAddr).to.equal("1.2.3.4");
      expect(sent.$broadcast).to.equal(true);
      expect(sent.$umid).to.match(/^[0-9a-f]{64}$/);
      expect(new Date(sent.$datetime).getTime()).to.be.greaterThan(0);
      // Posted to this node's own address
      expect(pendingCalls[0].remote).to.equal("10.0.0.1:5260");

      expect(reply.statusCode).to.equal(200);
      expect(reply.content.$umid).to.equal("u");
      expect(reply.content.$summary).to.deep.equal({
        total: 2,
        vote: 2,
        commit: 2,
      });
      expect(reply.content.$responses).to.deep.equal([{ hello: "world" }]);
      // The client has its answer: the locks are let go
      expect(released).to.deep.equal([["u"]]);
    });

    it("does not release locks the node says it is still holding", async () => {
      const { host, released } = makeHost({
        replies: [
          () =>
            Promise.resolve({
              status: 200,
              dontRelease: true,
              data: { $umid: "u", $nodes: { me: { vote: true, commit: true } } },
            }),
        ],
      });
      await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(released).to.deep.equal([]);
    });

    it("collects node errors, and the streams a node reports, for the client", async () => {
      const { host } = makeHost({
        replies: [
          voted({
            me: {
              vote: false,
              commit: false,
              error: "Some Rejection",
              streams: { new: [{ id: "n" }], updated: [] },
            },
          }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(reply.content.$summary.errors).to.deep.equal(["Some Rejection"]);
      expect(reply.content.$summary.commit).to.equal(0);
      expect(reply.content.$streams).to.deep.equal({
        new: [{ id: "n" }],
        updated: [],
      });
    });

    it("includes the whole entry for debugging only when debugToClient is on", async () => {
      ActiveOptions.set("debugToClient", true);
      try {
        const { host } = makeHost({
          replies: [voted({ me: { vote: true, commit: true } })],
        });
        const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
        expect(reply.content.$debug.$umid).to.equal("u");
      } finally {
        ActiveOptions.set("debugToClient", false);
      }
    });

    it("passes a non-200 from the node straight back to the client", async () => {
      const { host } = makeHost({
        replies: [() => Promise.resolve({ status: 403, data: "no" })],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(reply).to.deep.equal({ statusCode: 403, content: "no" });
    });

    it("treats an error inside a 200 as the answer, not as success", async () => {
      const { host } = makeHost({
        replies: [
          () => Promise.resolve({ status: 200, data: { error: "inside" } }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(reply).to.deep.equal({ statusCode: 200, content: { error: "inside" } });
    });

    it("sends it again, unchanged, when a 200 comes back empty", async () => {
      const { host, pendingCalls, released } = makeHost({
        replies: [
          () => Promise.resolve({ status: 200, data: undefined }),
          voted({ me: { vote: true, commit: true } }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(pendingCalls).to.have.length(2);
      // Same umid: the nodes' cached votes are reused
      expect(pendingCalls[1].entry.$umid).to.equal(pendingCalls[0].entry.$umid);
      expect(reply.content.$summary.commit).to.equal(1);
      expect(released[0][0]).to.equal(pendingCalls[0].entry.$umid);
    });

    it("retries under a new umid when every node reports busy locks", async () => {
      const { host, pendingCalls, released } = makeHost({
        replies: [
          voted({
            me: { vote: false, commit: false, error: "Busy Locks" },
            b: { vote: false, commit: false, error: "IBL01" },
          }),
          voted({ me: { vote: true, commit: true } }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(pendingCalls).to.have.length(2);
      expect(pendingCalls[1].entry.$umid).to.not.equal(pendingCalls[0].entry.$umid);
      // The previous round's votes do not leak into the retry
      expect(pendingCalls[1].entry.$nodes).to.equal(undefined);
      expect(released.length).to.be.greaterThan(0);
      expect(reply.content.$summary.commit).to.equal(1);
    });

    it("does not retry busy locks for a $nolock transaction", async () => {
      const { host, pendingCalls } = makeHost({
        replies: [
          voted({
            me: { vote: false, commit: false, error: "Busy Locks" },
            b: { vote: false, commit: false, error: "Busy Locks" },
          }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $nolock: true }),
        "1.2.3.4",
        db()
      );
      expect(pendingCalls).to.have.length(1);
      expect(reply.content.$summary.errors).to.deep.equal([
        "Busy Locks",
        "Busy Locks",
      ]);
    });

    it("retries when the node itself rejected with Busy Locks", async () => {
      const { host, pendingCalls, released } = makeHost({
        replies: [
          () => Promise.reject({ status: 100, error: "Busy Locks" }),
          voted({ me: { vote: true, commit: true } }),
        ],
      });
      const reply = await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db());
      expect(pendingCalls).to.have.length(2);
      expect(pendingCalls[1].entry.$umid).to.not.equal(pendingCalls[0].entry.$umid);
      // Released with the entry as owner, so another submission is not hit
      expect(released[0][1]).to.equal(pendingCalls[0].live);
      expect(reply.content.$summary.commit).to.equal(1);
    });

    it("tells a $nolock client Busy Locks as a failure inside a 200", async () => {
      const { host, pendingCalls } = makeHost({
        replies: [() => Promise.reject({ status: 100, error: "Busy Locks" })],
      });
      const reply = await Endpoints.ExternalInitalise(
        host,
        tx({ $nolock: true }),
        "1.2.3.4",
        db()
      );
      expect(pendingCalls).to.have.length(1);
      expect(reply.statusCode).to.equal(200);
      expect(reply.content.$summary.errors).to.deep.equal(["Busy Locks"]);
    });

    it("answers 500 with the message when the node throws an Error", async () => {
      const { host } = makeHost({
        replies: [() => Promise.reject(new Error("db down"))],
      });
      let caught: any;
      await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db()).catch(
        (e: any) => (caught = e)
      );
      expect(caught).to.deep.equal({
        statusCode: 500,
        content: { error: "db down" },
      });
    });

    it("answers 500 with whatever else the node rejected with", async () => {
      const { host } = makeHost({
        replies: [() => Promise.reject({ status: 7, why: "odd" })],
      });
      let caught: any;
      await Endpoints.ExternalInitalise(host, tx(), "1.2.3.4", db()).catch(
        (e: any) => (caught = e)
      );
      expect(caught.statusCode).to.equal(500);
      expect(caught.content).to.deep.equal({ status: 7, why: "odd" });
    });

    describe("territoriality", () => {
      it("is refused together with broadcast", async () => {
        const { host, pendingCalls } = makeHost({ replies: [] });
        const reply = await Endpoints.ExternalInitalise(
          host,
          tx({ $territoriality: "t", $broadcast: true }),
          "1.2.3.4",
          db()
        );
        expect(pendingCalls).to.have.length(0);
        expect(reply.content.$summary.errors).to.deep.equal([
          "Territoriality not supported in broadcast mode",
        ]);
      });

      it("is not turned into a broadcast, and is processed here when this node owns the territory", async () => {
        const { host, pendingCalls } = makeHost(
          { replies: [voted({ me: { vote: true, commit: true } })] },
          { terriMap: () => "me" }
        );
        await Endpoints.ExternalInitalise(
          host,
          tx({ $territoriality: "t" }),
          "1.2.3.4",
          db()
        );
        expect(pendingCalls).to.have.length(1);
        expect(pendingCalls[0].entry.$broadcast).to.equal(undefined);
      });

      const forwardingHost = (answer: any, knocks: any[]) =>
        makeHost(
          { replies: [] },
          {
            terriMap: () => "other",
            neighbourhood: {
              get: (ref: string) => ({
                knock: async (...a: any[]) => {
                  knocks.push([ref, ...a]);
                  return answer;
                },
              }),
            },
          }
        );

      it("is forwarded to the owning node, and its votes are what the client is told", async () => {
        const knocks: any[] = [];
        const { host, pendingCalls } = forwardingHost(
          {
            status: 200,
            data: {
              $umid: "fwd",
              $nodes: { other: { vote: true, commit: true } },
            },
          },
          knocks
        );
        const reply = await Endpoints.ExternalInitalise(
          host,
          tx({ $territoriality: "t" }),
          "1.2.3.4",
          db()
        );
        expect(pendingCalls).to.have.length(0);
        expect(knocks[0][0]).to.equal("other");
        expect(reply.statusCode).to.equal(200);
        expect(reply.content.$umid).to.equal("fwd");
        expect(reply.content.$summary).to.deep.equal({
          total: 1,
          vote: 1,
          commit: 1,
        });
      });

      it("passes the owning node's refusal back as a 200 rather than an HTTP error", async () => {
        const { host } = forwardingHost({ status: 403, data: { no: 1 } }, []);
        const reply = await Endpoints.ExternalInitalise(
          host,
          tx({ $territoriality: "t" }),
          "1.2.3.4",
          db()
        );
        expect(reply).to.deep.equal({ statusCode: 200, content: { no: 1 } });
      });

      it("fails with 500 when no node owns the territory", async () => {
        const { host } = makeHost({ replies: [] }, { terriMap: () => undefined });
        let caught: any;
        await Endpoints.ExternalInitalise(
          host,
          tx({ $territoriality: "t" }),
          "1.2.3.4",
          db()
        ).catch((e: any) => (caught = e));
        expect(caught).to.deep.equal({
          statusCode: 500,
          content: "Unknown territory",
        });
      });
    });

    describe("$multi", () => {
      const ok = (umid: string) => () =>
        Promise.resolve({
          status: 200,
          data: { $umid: umid, $nodes: { me: { vote: true, commit: true } } },
        });

      it("answers a list, in the order sent, one result per transaction", async () => {
        const order: string[] = [];
        const { host } = makeHost({ replies: [] });
        // Answer by what was asked, not by call order
        host.pending = (entry: any) => {
          order.push(entry.$sigs.signer);
          return ok("umid-" + entry.$sigs.signer)();
        };
        const reply = await Endpoints.ExternalInitalise(
          host,
          {
            $multi: [
              tx({ $sigs: { signer: "one" } }),
              tx({ $sigs: { signer: "two" } }),
              tx({ $sigs: { signer: "three" } }),
            ],
          },
          "1.2.3.4",
          db()
        );
        expect(reply.statusCode).to.equal(200);
        expect(reply.content.map((c: any) => c.$umid)).to.have.members([
          "umid-one",
          "umid-two",
          "umid-three",
        ]);
        expect(reply.content).to.have.length(3);
        // Order of the results follows the order sent
        expect(reply.content.map((c: any) => c.$umid)).to.deep.equal([
          "umid-one",
          "umid-two",
          "umid-three",
        ]);
        expect(order).to.have.length(3);
      });

      it("with $seq waits for each transaction before starting the next", async () => {
        let running = 0;
        let overlapped = false;
        const { host } = makeHost({ replies: [] });
        host.pending = async (entry: any) => {
          running++;
          if (running > 1) overlapped = true;
          await new Promise((r) => setTimeout(r, 20));
          running--;
          return {
            status: 200,
            data: { $umid: "u-" + entry.$sigs.signer, $nodes: { me: { vote: true, commit: true } } },
          };
        };
        const reply = await Endpoints.ExternalInitalise(
          host,
          {
            $seq: true,
            $multi: [
              tx({ $sigs: { signer: "one" } }),
              tx({ $sigs: { signer: "two" } }),
            ],
          },
          "1.2.3.4",
          db()
        );
        expect(overlapped).to.equal(false);
        expect(reply.content.map((c: any) => c.$umid)).to.deep.equal([
          "u-one",
          "u-two",
        ]);
        // KNOWN QUIRK, deliberately not asserted: $seq walks $multi from the
        // end (the `for (let i = n; i--;)` idiom), so the LAST transaction is
        // submitted first. A caller using $seq for dependent transactions
        // would expect the first one to go first.
      });
    });
  });

  describe("InternalInitalise", () => {
    const entry = (over: any = {}): any => ({
      $umid: "int-1",
      $tx: {},
      $broadcast: true,
      ...over,
    });

    it("answers with the node's status and data and clears $spiRetry", async () => {
      const { host, pendingCalls, released } = makeHost({
        replies: [
          () => Promise.resolve({ status: 200, data: { $umid: "int-1", ok: 1 } }),
        ],
      });
      const e = entry({ $spiRetry: true });
      const reply = await Endpoints.InternalInitalise(host, e, "10.0.0.2");
      expect(reply).to.deep.equal({
        statusCode: 200,
        content: { $umid: "int-1", ok: 1 },
      });
      expect(e.$spiRetry).to.equal(false);
      // internal = true, forceRestart = false, isP2P = false
      expect(pendingCalls[0].rest).to.deep.equal([true, false, false]);
      // No votes to look at: locks are released
      expect(released).to.deep.equal([["int-1"]]);
    });

    it("keeps the locks when the node says not to release", async () => {
      const { host, released } = makeHost({
        replies: [
          () =>
            Promise.resolve({
              status: 200,
              dontRelease: true,
              data: { ok: 1 },
            }),
        ],
      });
      await Endpoints.InternalInitalise(host, entry(), "10.0.0.2");
      expect(released).to.deep.equal([]);
    });

    it("tells the pending call it came by P2P", async () => {
      const { host, pendingCalls } = makeHost({
        replies: [() => Promise.resolve({ status: 200, data: {} })],
      });
      await Endpoints.InternalInitalise(host, entry(), "10.0.0.2", false, true);
      expect(pendingCalls[0].rest[2]).to.equal(true);
    });

    it("releases the voted-on transaction when this node's own vote had no SPI error", async () => {
      const { host, released } = makeHost({
        replies: [voted({ me: { vote: true, commit: false } })],
      });
      const reply = await Endpoints.InternalInitalise(host, entry(), "10.0.0.2");
      expect(reply.statusCode).to.equal(200);
      expect(released).to.deep.equal([["int-1"]]);
    });

    it("releases and keeps the answer when this node's error is not a stream position error", async () => {
      const { host, released } = makeHost({
        replies: [
          voted({ me: { vote: false, commit: false, error: "Contract said no" } }),
        ],
      });
      const reply = await Endpoints.InternalInitalise(host, entry(), "10.0.0.2");
      expect(reply.content.$nodes.me.error).to.equal("Contract said no");
      expect(released).to.deep.equal([["int-1"]]);
    });

    it("answers 500 and releases (as owner) when the node cannot take the transaction", async () => {
      const { host, released } = makeHost({
        replies: [() => Promise.reject(new Error("boom"))],
      });
      const e = entry();
      let caught: any;
      await Endpoints.InternalInitalise(host, e, "10.0.0.2").catch(
        (x: any) => (caught = x)
      );
      expect(caught.statusCode).to.equal(500);
      expect(caught.content).to.be.an("error");
      expect(released).to.deep.equal([["int-1", e]]);
    });

    it("asks the network about its streams, and gives up cleanly without enough answers, when a unanimous transaction hit a position error", async () => {
      ActiveOptions.set("consensus", { reached: 66 });
      const stream = "s".repeat(64);
      const asked: any[] = [];
      const { host } = makeHost(
        {
          replies: [
            voted(
              { me: { vote: false, commit: false, error: "Stream Position Incorrect" } },
              {
                $tx: { $contract: "c".repeat(64), $i: { [stream]: {} }, $o: {} },
              }
            ),
          ],
        },
        {
          neighbourhood: {
            count: () => 4,
            // Fewer answers than consensus needs: nothing is rewritten
            knockAll: async (path: string, body: any) => {
              asked.push([path, body]);
              return [];
            },
          },
        }
      );
      try {
        const reply = await Endpoints.InternalInitalise(
          host,
          entry({ $unanimous: true }),
          "10.0.0.2"
        );
        expect(reply.statusCode).to.equal(200);
        expect(asked).to.have.length(1);
        expect(asked[0][0]).to.equal("stream");
        // Asked about the stream, its :stream doc and the contract data
        expect(asked[0][1].$streams).to.have.members([
          stream,
          `${stream}:stream`,
          `${"c".repeat(64)}:data`,
        ]);
        expect(asked[0][1].$umid).to.equal("int-1");
      } finally {
        ActiveOptions.set("consensus", undefined);
      }
    });
  });

  describe("status", () => {
    const neighbour = (reference: string, over: any = {}) => ({
      reference,
      isHome: true,
      graceStop: false,
      ...over,
    });

    it("tells a live neighbour 200 and a stranger 403", async () => {
      const hood: any = { live: neighbour("live"), stopping: neighbour("stopping", { graceStop: true }) };
      const host: any = {
        neighbourhood: { get: (ref?: string) => (ref ? hood[ref] : hood), keys: () => Object.keys(hood) },
      };
      expect(await Endpoints.status(host, "live")).to.deep.equal({ statusCode: 200 });
      expect(await Endpoints.status(host, "stopping")).to.deep.equal({ statusCode: 403 });
      expect(await Endpoints.status(host, "stranger")).to.deep.equal({ statusCode: 403 });
    });

    it("asks for the ordering to be rebased after enough status pings, then starts counting again", async () => {
      const real = Maintain.rebaseNeighbourhood;
      let rebases = 0;
      Maintain.rebaseNeighbourhood = (() => rebases++) as any;
      const realThrottle = Endpoints.rebaseThrottle;
      Endpoints.rebaseThrottle = 0;
      ActiveOptions.set("rebaseThrottle", 2);
      const host: any = {
        neighbourhood: { get: () => undefined, keys: () => [] },
      };
      try {
        await Endpoints.status(host, "x");
        await Endpoints.status(host, "x");
        expect(rebases).to.equal(0);
        await Endpoints.status(host, "x");
        expect(rebases).to.equal(1);
        expect(Endpoints.rebaseThrottle).to.equal(0);
      } finally {
        Maintain.rebaseNeighbourhood = real;
        Endpoints.rebaseThrottle = realThrottle;
        ActiveOptions.set("rebaseThrottle", undefined);
      }
    });

    it("gives an anonymous caller the node's identity and the neighbours still serving", async () => {
      Home.left = { reference: "L" } as any;
      Home.right = { reference: "R" } as any;
      Home.publicPem = "PEM";
      const hood: any = {
        a: neighbour("a"),
        b: neighbour("b", { isHome: false }),
        c: neighbour("c", { graceStop: true }),
      };
      const host: any = {
        reference: "me",
        getStatus: () => "STATUS",
        neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
      };
      const reply = await Endpoints.status(host, "NA");
      expect(reply.statusCode).to.equal(200);
      expect(reply.content).to.deep.equal({
        status: "STATUS",
        reference: "me",
        left: "L",
        right: "R",
        neighbourhood: {
          neighbours: { a: { isHome: true }, b: { isHome: false } },
        },
        pem: "PEM",
      });
    });
  });

  describe("all / umid", () => {
    it("lists the stream ids and revisions, leaving out volatile documents", async () => {
      const options: any[] = [];
      const reply = await Endpoints.all({
        allDocs: async (o: any) => {
          options.push(o);
          return {
            rows: [
              { id: "a", value: { rev: "1-x" } },
              { id: "a:volatile", value: { rev: "1-y" } },
              { id: "b:stream", value: { rev: "2-z" } },
            ],
          };
        },
      } as any);
      expect(options).to.deep.equal([{ limit: 500 }]);
      expect(reply).to.deep.equal({
        statusCode: 200,
        content: [
          { id: "a", rev: "1-x" },
          { id: "b:stream", rev: "2-z" },
        ],
      });
    });

    it("pages from a start key, skipping the row the caller already has", async () => {
      const options: any[] = [];
      await Endpoints.all(
        {
          allDocs: async (o: any) => (options.push(o), { rows: [] }),
        } as any,
        "k"
      );
      expect(options).to.deep.equal([{ limit: 500, startkey: "k", skip: 1 }]);
    });

    it("answers { error: 3 } when the database cannot be read", async () => {
      let caught: any;
      await Endpoints.all({
        allDocs: () => Promise.reject(new Error("x")),
      } as any).catch((e: any) => (caught = e));
      expect(caught).to.deep.equal({ error: 3 });
    });

    it("fetches the umid document", async () => {
      const asked: string[] = [];
      const reply = await Endpoints.umid(
        { get: async (id: string) => (asked.push(id), { _id: id }) } as any,
        "abc"
      );
      expect(asked).to.deep.equal(["abc:umid"]);
      expect(reply).to.deep.equal({ statusCode: 200, content: { _id: "abc:umid" } });
    });

    it("answers { error: 2 } for a umid it does not hold", async () => {
      let caught: any;
      await Endpoints.umid({
        get: () => Promise.reject(new Error("missing")),
      } as any, "abc").catch((e: any) => (caught = e));
      expect(caught).to.deep.equal({ error: 2 });
    });
  });

  describe("ExternalEncrypt (deprecated)", () => {
    it("insists on the encrypt header", async () => {
      let caught: any;
      await Endpoints.ExternalEncrypt({} as any, {}, false, {} as any).catch(
        (e: any) => (caught = e)
      );
      expect(caught).to.deep.equal({
        statusCode: 500,
        content: "Must be sent over X-Activeledger-Encrypt",
      });
    });
  });

  describe("postConvertor", () => {
    const host = (over: any = {}): any => ({
      reference: "me",
      decrypt: (s: string) => s,
      neighbourhood: {
        get: () => ({ verifySignature: () => true }),
      },
      ...over,
    });

    it("parses a plain JSON body", async () => {
      const out = await Endpoints.postConvertor(host(), '{"a":1}', false);
      expect(out).to.deep.equal({ body: { a: 1 } });
    });

    it("parses a Buffer body too", async () => {
      const out = await Endpoints.postConvertor(host(), Buffer.from('{"a":2}'), false);
      expect(out).to.deep.equal({ body: { a: 2 } });
    });

    it("answers 500 for a body that is not JSON", async () => {
      let caught: any;
      await Endpoints.postConvertor(host(), "{nope", false).catch(
        (e: any) => (caught = e)
      );
      expect(caught).to.deep.equal({
        statusCode: 500,
        content: "Deserialization Error",
      });
    });

    it("answers 500 for an encrypted body that cannot be decrypted", async () => {
      let caught: any;
      await Endpoints.postConvertor(
        host({
          decrypt: () => {
            throw new Error("bad key");
          },
        }),
        "garbage",
        true
      ).catch((e: any) => (caught = e));
      expect(caught).to.deep.equal({
        statusCode: 500,
        content: "Decryption Error",
      });
    });

    it("decrypts an encrypted body", async () => {
      const plain = Buffer.from('{"decrypted":true}').toString("base64");
      const out = await Endpoints.postConvertor(
        host({ decrypt: (s: string) => (s === "cipher" ? plain : "") }),
        "cipher",
        true
      );
      expect(out).to.deep.equal({ body: { decrypted: true } });
    });

    const packet = (over: any = {}) =>
      JSON.stringify({
        $neighbour: { reference: "peer", signature: "sig" },
        $packet: { inner: 1 },
        ...over,
      });

    it("unwraps a neighbour packet whose signature verifies, naming who it is from", async () => {
      const verified: any[] = [];
      const out = await Endpoints.postConvertor(
        host({
          neighbourhood: {
            get: (ref: string) => ({
              verifySignature: (sig: string, p: any) => (
                verified.push([ref, sig, p]), true
              ),
            }),
          },
        }),
        packet(),
        false
      );
      expect(out).to.deep.equal({ from: "peer", body: { inner: 1 } });
      expect(verified).to.deep.equal([["peer", "sig", { inner: 1 }]]);
    });

    it("answers 500 for a neighbour packet whose signature does not verify", async () => {
      let caught: any;
      await Endpoints.postConvertor(
        host({
          neighbourhood: { get: () => ({ verifySignature: () => false }) },
        }),
        packet(),
        false
      ).catch((e: any) => (caught = e));
      expect(caught).to.deep.equal({
        statusCode: 500,
        content: "Security Challenge Failure",
      });
    });

    it("decrypts a neighbour packet marked $enc, but not one from itself", async () => {
      const inner = Buffer.from('{"secret":1}').toString("base64");
      const decrypted: string[] = [];
      const h = host({
        decrypt: (s: string) => (decrypted.push(s), inner),
      });
      const fromPeer = await Endpoints.postConvertor(
        h,
        packet({ $enc: true, $packet: "ciphertext", $neighbour: { reference: "peer" } }),
        false
      );
      expect(fromPeer).to.deep.equal({ from: "peer", body: { secret: 1 } });
      expect(decrypted).to.deep.equal(["ciphertext"]);

      const fromSelf = await Endpoints.postConvertor(
        h,
        packet({ $enc: true, $packet: { plain: 1 }, $neighbour: { reference: "me" } }),
        false
      );
      expect(fromSelf).to.deep.equal({ from: "me", body: { plain: 1 } });
      expect(decrypted).to.have.length(1);
    });

    it("insists on a valid signature when signedConsensus is configured", async () => {
      ActiveOptions.set("security", { signedConsensus: true });
      try {
        let caught: any;
        await Endpoints.postConvertor(
          host({
            neighbourhood: { get: () => ({ verifySignature: () => false }) },
          }),
          packet({ $neighbour: { reference: "peer" } }),
          false
        ).catch((e: any) => (caught = e));
        expect(caught.content).to.equal("Security Challenge Failure");
      } finally {
        ActiveOptions.set("security", undefined);
      }
    });
  });
});
