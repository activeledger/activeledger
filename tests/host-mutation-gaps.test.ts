import { expect } from "chai";
import "mocha";
// By package name: host reads options through the built lib's ActiveOptions
import { ActiveOptions } from "@activeledger/activeoptions";
import { Host } from "../packages/network/src/network/host";

const H: any = Host;

/**
 * Edges a mutation pass over network/host.ts found nothing checking: the
 * request size limit, the answers for a refused request, when a response is
 * compressed, who a broadcast goes to, and a stray peer answer.
 */
describe("Host - edges the tests did not pin (Activenetwork)", () => {
  const bare = (extra: any = {}): any => Object.assign(Object.create(Host.prototype), extra);

  /** A uWebSockets-style response that records what is written to it */
  const fakeRes = (writable = true) => {
    const out: any = { status: undefined, headers: {} as any, ended: undefined as any, writable };
    out.cork = (fn: () => void) => fn();
    out.writeStatus = (s: string) => (out.status = s);
    out.writeHeader = (k: string, v: string) => (out.headers[k] = v);
    out.end = (...a: any[]) => (out.ended = a);
    return out;
  };

  describe("the largest request body accepted", () => {
    const DEFAULT = 16 * 1024 * 1024;
    let saved: any;
    beforeEach(() => (saved = ActiveOptions.get("security", undefined)));
    afterEach(() => ActiveOptions.set("security", saved));

    it("is 16MB unless configured", () => {
      ActiveOptions.set("security", {});
      expect(H.maxRequestBytes).to.equal(DEFAULT);
    });
    it("is what the config says when that is a usable number", () => {
      ActiveOptions.set("security", { maxRequestBytes: 1000 });
      expect(H.maxRequestBytes).to.equal(1000);
    });
    for (const [name, value] of [["zero", 0], ["negative", -5], ["infinite", Infinity], ["not a number", "lots"]] as const) {
      it(`falls back to 16MB when the config says ${name}`, () => {
        ActiveOptions.set("security", { maxRequestBytes: value });
        expect(H.maxRequestBytes).to.equal(DEFAULT);
      });
    }
  });

  describe("refusing a request", () => {
    it("answers 413 and closes the connection for one that is too large", () => {
      const res = fakeRes();
      bare().rejectTooLarge(res);
      expect(res.status).to.equal("413 Payload Too Large");
      expect(res.headers.Connection).to.equal("close");
      expect(JSON.parse(res.ended[0])).to.deep.equal({ error: "Request too large" });
      expect(res.ended[1]).to.equal(true);
      expect(res.writable).to.equal(false);
    });

    it("answers 400 for a body that cannot be read, and takes no further writes", () => {
      const res = fakeRes();
      bare().rejectBadBody(res);
      expect(res.status).to.equal("400 Bad Request");
      expect(res.writable).to.equal(false);
    });

    it("writes nothing to a response that is already closed", () => {
      for (const refuse of ["rejectTooLarge", "rejectBadBody"]) {
        const res = fakeRes(false);
        bare()[refuse](res);
        expect(res.status, refuse).to.equal(undefined);
      }
    });
  });

  describe("compressing a response", () => {
    const run = async (size: number) => {
      const res = fakeRes();
      await bare().writeResponse(res, 200, "x".repeat(size), "gzip");
      return res;
    };

    it("compresses one of exactly the minimum size", async () => {
      expect((await run(16384)).headers["Content-Encoding"]).to.equal("gzip");
    });
    it("sends a smaller one as it is", async () => {
      expect((await run(16383)).headers["Content-Encoding"]).to.equal(undefined);
    });
    it("takes no further writes once the answer has gone", async () => {
      expect((await run(10)).writable).to.equal(false);
    });
  });

  describe("broadcasting a transaction", () => {
    const peer = (reference: string, isHome: boolean, calls: any[]) => ({
      reference,
      isHome,
      knock: (...a: any[]) => (calls.push([reference, a]), Promise.resolve()),
    });

    it("bundles one request to each other node that is home, and none to itself or one that is down", async () => {
      const calls: any[] = [];
      const nodes: any = {
        me: peer("me", true, calls),
        a: peer("a", true, calls),
        down: peer("down", false, calls),
      };
      const host = bare({
        reference: "me",
        processPending: { u: { entry: { $umid: "u", $broadcast: true, $nodes: { me: { vote: true } } } } },
        neighbourhood: { get: () => nodes, keys: () => Object.keys(nodes) },
      });
      (host as any).broadcast("u", false, true);
      await new Promise((r) => setImmediate(r));
      expect(calls.map((c) => c[0])).to.deep.equal(["a"]);
      // knock("init", data, false, 0, true, serialiseOnce): bundled, and one shared serialisation
      expect(calls[0][1][0]).to.equal("init");
      expect(calls[0][1][2]).to.equal(false);
      expect(calls[0][1][3]).to.equal(0);
      expect(calls[0][1][4]).to.equal(true);
      expect(calls[0][1][5]).to.be.a("function");
    });
  });

  describe("a peer's answer for a transaction this node no longer holds", () => {
    it("is acknowledged without releasing anything", async () => {
      const host = bare({ processPending: {} });
      const reply = await host.pending({ $umid: "gone", $broadcast: true } as any, "10.0.0.1");
      expect(reply).to.deep.equal({ status: 200, data: { ok: true }, dontRelease: true });
    });
  });
});
