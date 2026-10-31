import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import Setup from "../packages/activeledger/src/contracts/default/setup";

// The default "setup" contract manages the network's own setup stream: assert
// the network to the ledger, add/remove nodes, approve/revoke namespace
// imports and change the hybrid rules. It is driven here through its public
// phases (verify / vote / commit / postProcess) over a hand-built context, as
// the other default contract tests do: what matters is what each phase
// accepts, refuses and writes, not a full contract execution.
describe("Default setup contract (Activeledger)", () => {
  type Settled = { ok: unknown } | { err: unknown } | { pending: true };

  // A phase that neither resolves nor rejects must not hang the suite
  const settle = (p: Promise<unknown>): Promise<Settled> =>
    Promise.race([
      p.then(
        (ok) => ({ ok }),
        (err) => ({ err })
      ),
      new Promise<Settled>((r) => setTimeout(() => r({ pending: true }), 50)),
    ]);

  const accepted = async (p: Promise<unknown>) => {
    const r = await settle(p);
    expect(r, "should resolve").to.deep.equal({ ok: true });
  };
  const refused = async (p: Promise<unknown>, reason: string) => {
    const r = await settle(p);
    expect(r).to.deep.equal({ err: reason });
  };

  // Network nodes, each with a real key
  const makeNode = (port: number) => {
    const kp = new ActiveCrypto.KeyPair("secp256k1");
    const keys = kp.generate(2048, true);
    return {
      kp,
      entry: {
        host: "10.0.0." + port,
        port,
        identity: { type: "secp256k1", public: keys.pub.pkcs8pem },
      },
      name: `10.0.0.${port}:${port}`,
    };
  };
  const nodes = [makeNode(1), makeNode(2), makeNode(3)];
  const neighbourhood = () => nodes.map((n) => JSON.parse(JSON.stringify(n.entry)));

  // Stand-in for a stream's Activity
  const fakeActivity = (state: any, name = "netstream", rev = "2-abc") => ({
    state: { ...state, _rev: rev },
    locks: [] as any[],
    getState() {
      return this.state;
    },
    setState(s: any) {
      this.state = { ...s, _rev: rev };
    },
    getName() {
      return name;
    },
    setContractLock(l: any) {
      this.locks.push(l);
      return true;
    },
  });

  let originalBuild: any;
  before(() => {
    originalBuild = ActiveOptions.get("build", 0);
  });
  afterEach(() => ActiveOptions.set("build", originalBuild));

  const make = (entry: string, input: any, extra: any = {}) => {
    const s: any = Object.create(Setup.prototype);
    s.transactions = { $namespace: "default", $contract: "setup", $entry: entry, $i: input, $o: extra.$o || {} };
    s.config = extra.config ?? { neighbourhood: neighbourhood(), network: "netstream@2-abc" };
    s.sigs = extra.sigs ?? {};
    s.updateConfig = false;
    s.reloadConfig = false;
    s.assertedHybrid = false;
    s.streams = extra.streams ?? {};
    s.getActivityStreams = (name: string) => s.streams[name];
    s.createdStream = null;
    s.newActivityStream = (name: string) => {
      s.createdStream = fakeActivity({}, "new." + name, "1-new");
      return s.createdStream;
    };
    return s;
  };

  // Sign the transaction with the first n nodes (and a placeholder identity sig)
  const signWith = (s: any, count: number) => {
    const sigs: any = { identity: "self" };
    for (const n of nodes.slice(0, count)) sigs[n.name] = n.kp.sign(s.transactions);
    s.sigs = sigs;
    return s;
  };

  describe("entry dispatch", () => {
    for (const phase of ["verify", "vote", "commit"]) {
      it(`${phase} refuses an unknown entry`, async () => {
        await refused((make("bogus", {}) as any)[phase](true), "unknown entry");
      });
    }
  });

  describe("sysConfig and configReload", () => {
    it("keeps the configuration it is given and reports no reload by default", () => {
      const s = make("assert", {});
      const cfg = { a: 1 };
      s.sysConfig(cfg);
      expect(s.config).to.equal(cfg);
      expect(s.configReload()).to.equal(false);
    });
  });

  describe("assert", () => {
    const setup = (over: any = {}) => ({
      setup: {
        security: { namespace: {} },
        consensus: { reboot: true },
        neighbourhood: neighbourhood(),
        ...over,
      },
    });

    it("verify needs a self signed transaction", async () => {
      await refused(make("assert", setup()).verify(false), "Must be self signed");
    });

    it("verify needs security, consensus and neighbourhood", async () => {
      for (const missing of ["security", "consensus", "neighbourhood"]) {
        const input = setup();
        delete (input.setup as any)[missing];
        await refused(make("assert", input).verify(true), "Missing Assert Fields");
      }
      await refused(make("assert", {}).verify(true), "Missing Assert Fields");
      await accepted(make("assert", setup()).verify(true));
    });

    it("verify validates a hybrid section only once the build supports one", async () => {
      const bad = setup({ hybrid: { admission: "nonsense" } });
      ActiveOptions.set("build", 40299);
      await accepted(make("assert", bad).verify(true));
      ActiveOptions.set("build", 40300);
      const r = await settle(make("assert", bad).verify(true));
      expect(r).to.deep.equal({ err: 'hybrid.admission must be "open" or {allowlist:[keys]}' });
      await accepted(
        make("assert", setup({ hybrid: { admission: "open", required: [], window: { days: 1 }, minVersion: "5.1.0" } })).verify(true)
      );
    });

    it("verify ignores the legacy hybrid URL list", async () => {
      ActiveOptions.set("build", 40300);
      await accepted(make("assert", setup({ hybrid: ["http://a"] })).verify(true));
    });

    it("vote accepts a matching neighbourhood carrying a valid node signature", async () => {
      const s = make("assert", setup());
      signWith(s, 1);
      await accepted(s.vote());
    });

    it("vote accepts the neighbourhood in a different order", async () => {
      const s = make("assert", setup({ neighbourhood: neighbourhood().reverse() }));
      signWith(s, 1);
      await accepted(s.vote());
    });

    it("vote refuses a neighbourhood that differs from the node's own", async () => {
      const other = neighbourhood();
      other[0].port = 9999;
      const s = make("assert", setup({ neighbourhood: other }));
      signWith(s, 3);
      await refused(s.vote(), "Network Neighborhood not matching");
    });

    it("vote refuses a neighbourhood with a different number of nodes", async () => {
      const s = make("assert", setup({ neighbourhood: neighbourhood().slice(1) }));
      signWith(s, 3);
      await refused(s.vote(), "Network Neighborhood not matching");
    });

    it("vote refuses a signature that does not verify", async () => {
      const s = make("assert", setup());
      signWith(s, 0);
      s.sigs[nodes[0].name] = nodes[1].kp.sign(s.transactions);
      await refused(s.vote(), "Found invalid node signature");
    });

    it("vote refuses a matching neighbourhood when no configured node signed", async () => {
      const s = make("assert", setup());
      await refused(s.vote(), "Host node signature problem");
    });

    it("commit builds the setup stream from the asserted fields", async () => {
      const input = setup({ lock: "extra" });
      const s = make("assert", input);
      await accepted(s.commit());
      const created = s.createdStream;
      expect(created.state.neighbourhood).to.deep.equal(input.setup.neighbourhood);
      expect(created.state.security).to.deep.equal({ namespace: {} });
      expect(created.state.consensus).to.deep.equal({ reboot: true });
      expect(created.state).to.not.have.property("hybrid");
      expect(created.locks).to.deep.equal([["extra", "setup"]]);
      expect(s.config.network).to.equal("new.contract.default.setup@assertion");
      expect(s.updateConfig).to.equal(true);
      expect(s.assertedHybrid).to.equal(false);
    });

    it("commit locks only the setup contract by default and adds a security lock", async () => {
      const s = make("assert", setup());
      await accepted(s.commit());
      expect(s.createdStream.locks).to.deep.equal(["setup"]);

      const t = make("assert", setup({ security: { namespace: {}, lock: "sec" } }));
      await accepted(t.commit());
      expect(t.createdStream.locks).to.deep.equal(["setup", "sec"]);
    });

    it("commit adds the namespace import table when security lacks one", async () => {
      const s = make("assert", setup({ security: { other: 1 } }));
      await accepted(s.commit());
      expect(s.createdStream.state.security).to.deep.equal({ other: 1, namespace: {} });
    });

    it("commit puts the hybrid section on the ledger from build 40300 only", async () => {
      const hybrid = { admission: "open", required: [], window: { days: 1 }, minVersion: "5.1.0" };
      ActiveOptions.set("build", 40299);
      const before = make("assert", setup({ hybrid }));
      await accepted(before.commit());
      expect(before.createdStream.state).to.not.have.property("hybrid");
      expect(before.assertedHybrid).to.equal(false);

      ActiveOptions.set("build", 40300);
      const after = make("assert", setup({ hybrid }));
      await accepted(after.commit());
      expect(after.createdStream.state.hybrid).to.deep.equal(hybrid);
      expect(after.assertedHybrid).to.equal(true);
    });
  });

  describe("add node", () => {
    const suggester = (over: any = {}) => ({
      suggester: { host: "10.0.0.4", port: 4, identity: { type: "secp256k1", public: "p" }, ...over },
    });

    it("verify needs a self signed transaction and the node's identity, host and port", async () => {
      await refused(make("add", suggester()).verify(false), "Must be self signed");
      for (const missing of ["identity", "host", "port"]) {
        const input = suggester();
        delete (input.suggester as any)[missing];
        await refused(make("add", input).verify(true), "Missing Add Node Fields");
      }
      await refused(make("add", {}).verify(true), "Missing Add Node Fields");
      await accepted(make("add", suggester()).verify(true));
    });

    it("vote needs a majority of valid node signatures", async () => {
      const s = make("add", suggester());
      signWith(s, 1);
      await refused(s.vote(), "Host node signature problem");
      await accepted(signWith(make("add", suggester()), 3).vote());
    });

    it("vote refuses a node already in the neighbourhood", async () => {
      const s = make("add", suggester({ host: "10.0.0.2", port: 2 }));
      signWith(s, 3);
      await refused(s.vote(), "Node already exists");
    });

    it("vote refuses a forged signature", async () => {
      const s = make("add", suggester());
      signWith(s, 3);
      s.sigs[nodes[1].name] = nodes[0].kp.sign(s.transactions);
      await refused(s.vote(), "Host node signature problem");
    });

    it("commit appends the node and asks for a reload", async () => {
      const activity = fakeActivity({ neighbourhood: neighbourhood() });
      const s = make("add", suggester(), { $o: { net: {} }, streams: { net: activity } });
      await accepted(s.commit());
      const hoods = activity.getState().neighbourhood;
      expect(hoods).to.have.length(4);
      expect(hoods[3]).to.deep.equal(suggester().suggester);
      expect(s.configReload()).to.equal(true);
      expect(s.updateConfig).to.equal(true);
      expect(s.config.network).to.equal("netstream@2-abc");
    });
  });

  describe("remove node", () => {
    const suggester = (over: any = {}) => ({
      suggester: { host: "10.0.0.2", port: 2, identity: { type: "secp256k1", public: "p" }, ...over },
    });

    it("verify needs a self signed transaction and the node's identity, host and port", async () => {
      await refused(make("remove", suggester()).verify(false), "Must be self signed");
      for (const missing of ["identity", "host", "port"]) {
        const input = suggester();
        delete (input.suggester as any)[missing];
        await refused(make("remove", input).verify(true), "Missing Remove Node Fields");
      }
      await accepted(make("remove", suggester()).verify(true));
    });

    it("vote accepts removing a node that exists", async () => {
      await accepted(signWith(make("remove", suggester()), 3).vote());
    });

    it("vote refuses removing a node that does not exist", async () => {
      await refused(
        signWith(make("remove", suggester({ host: "10.9.9.9", port: 9 })), 3).vote(),
        "Node doesn't exists"
      );
    });

    it("vote refuses without enough valid signatures", async () => {
      await refused(signWith(make("remove", suggester()), 1).vote(), "Host node signature problem");
    });

    it("commit drops only the removed node and asks for a reload", async () => {
      const activity = fakeActivity({ neighbourhood: neighbourhood() });
      const s = make("remove", suggester(), { $o: { net: {} }, streams: { net: activity } });
      await accepted(s.commit());
      const left = activity.getState().neighbourhood.map((n: any) => n.port).sort();
      expect(left).to.deep.equal([1, 3]);
      expect(s.configReload()).to.equal(true);
      expect(s.updateConfig).to.equal(true);
      expect(s.config.network).to.equal("netstream@2-abc");
    });
  });

  describe("namespace import rules", () => {
    const approve = (over: any = {}) => ({
      suggester: { namespace: "ns1", libs: { std: ["fs", "path"] }, ...over },
    });

    it("approve verify needs a self signed transaction with a namespace and libs", async () => {
      await refused(make("approve", approve()).verify(false), "Must be self signed");
      await refused(make("approve", { suggester: { namespace: "ns" } }).verify(true), "Missing Approve Namespace Fields");
      await refused(make("approve", { suggester: { libs: {} } }).verify(true), "Missing Approve Namespace Fields");
      await refused(make("approve", {}).verify(true), "Missing Approve Namespace Fields");
      await accepted(make("approve", approve()).verify(true));
    });

    it("approve verify refuses npm libraries and requires standard ones", async () => {
      await refused(
        make("approve", approve({ libs: { std: ["fs"], npm: ["left-pad"] } })).verify(true),
        "NPM libraries not supported yet"
      );
      await refused(make("approve", approve({ libs: {} })).verify(true), "Only support standard libraries");
    });

    it("approve vote needs a majority and string-only libraries", async () => {
      await accepted(signWith(make("approve", approve()), 3).vote());
      await accepted(signWith(make("approve", approve({ libs: { std: "fs" } })), 3).vote());
      await refused(signWith(make("approve", approve()), 1).vote(), "Host node signature problem");
      await refused(
        signWith(make("approve", approve({ libs: { std: ["fs", 5] } })), 3).vote(),
        "Invalid Standard Input"
      );
    });

    it("approve commit records the namespace's standard libraries", async () => {
      const activity = fakeActivity({ security: { namespace: {} }, neighbourhood: [] });
      const s = make("approve", approve({ libs: { std: "fs" } }), { $o: { net: {} }, streams: { net: activity } });
      await accepted(s.commit());
      expect(activity.getState().security.namespace).to.deep.equal({ ns1: { std: ["fs"], npm: [] } });
      expect(s.configReload()).to.equal(true);
      expect(s.updateConfig).to.equal(true);
      expect(s.config.network).to.equal("netstream@2-abc");
    });

    it("approve commit treats a non-list, non-string std as no libraries", async () => {
      const activity = fakeActivity({ security: { namespace: {} } });
      const s = make("approve", approve({ libs: { std: 7 } }), { $o: { net: {} }, streams: { net: activity } });
      await accepted(s.commit());
      expect(activity.getState().security.namespace.ns1.std).to.deep.equal([]);
    });

    const revoke = { suggester: { namespace: "ns1" } };

    it("revoke verify needs a self signed transaction with a namespace", async () => {
      await refused(make("revoke", revoke).verify(false), "Must be self signed");
      await refused(make("revoke", { suggester: {} }).verify(true), "Missing Revoke Namespace Fields");
      await refused(make("revoke", {}).verify(true), "Missing Revoke Namespace Fields");
      await accepted(make("revoke", revoke).verify(true));
    });

    it("revoke vote needs a majority of valid signatures", async () => {
      await accepted(signWith(make("revoke", revoke), 3).vote());
      await refused(signWith(make("revoke", revoke), 1).vote(), "Host node signature problem");
    });

    it("revoke commit removes only that namespace", async () => {
      const activity = fakeActivity({
        security: { namespace: { ns1: { std: [], npm: [] }, ns2: { std: ["fs"], npm: [] } } },
      });
      const s = make("revoke", revoke, { $o: { net: {} }, streams: { net: activity } });
      await accepted(s.commit());
      expect(Object.keys(activity.getState().security.namespace)).to.deep.equal(["ns2"]);
      expect(s.configReload()).to.equal(true);
      expect(s.updateConfig).to.equal(true);
    });
  });

  describe("hybrid change", () => {
    const hybridState = () => ({
      admission: { allowlist: ["k1"] },
      required: [],
      window: { days: 7 },
      minVersion: "5.1.0",
    });
    const change = (c: any) => ({ suggester: { change: c } });

    it("verify is refused until the network build supports it", async () => {
      ActiveOptions.set("build", 40299);
      await refused(make("hybrid", change({ minVersion: "5.2.0" })).verify(true), "Hybrid changes need build 40300");
    });

    it("verify needs a self signed transaction carrying a change", async () => {
      ActiveOptions.set("build", 40300);
      await refused(make("hybrid", change({})).verify(false), "Must be self signed");
      await refused(make("hybrid", { suggester: {} }).verify(true), "Missing Hybrid Change Fields");
      await refused(make("hybrid", {}).verify(true), "Missing Hybrid Change Fields");
    });

    it("verify checks the change itself", async () => {
      ActiveOptions.set("build", 40300);
      await accepted(make("hybrid", change({ minVersion: "5.2.0" })).verify(true));
      await refused(make("hybrid", change({ minVersion: "latest" })).verify(true), "hybrid.minVersion must be a semver version");
      await refused(make("hybrid", change({ window: 1 })).verify(true), "Unknown hybrid change");
      await refused(make("hybrid", change(["x"])).verify(true), "Unknown hybrid change");
    });

    it("vote needs a strict majority of valid signatures from distinct configured nodes", async () => {
      const outputs = { $o: { netstream: {} } };
      await accepted(signWith(make("hybrid", change({}), outputs), 2).vote());
      await refused(signWith(make("hybrid", change({}), outputs), 1).vote(), "Host node signature problem");
    });

    it("vote does not count signatures from nodes that are not configured", async () => {
      const outputs = { $o: { netstream: {} } };
      const s = signWith(make("hybrid", change({}), outputs), 1);
      const stranger = makeNode(77);
      s.sigs[stranger.name] = stranger.kp.sign(s.transactions);
      s.sigs["10.0.0.50:50"] = "junk";
      await refused(s.vote(), "Host node signature problem");
    });

    it("vote does not count an unusable signature", async () => {
      const outputs = { $o: { netstream: {} } };
      const s = signWith(make("hybrid", change({}), outputs), 2);
      s.sigs[nodes[1].name] = "not a signature";
      await refused(s.vote(), "Host node signature problem");
      const t = signWith(make("hybrid", change({}), outputs), 2);
      t.sigs[nodes[1].name] = 12345;
      await refused(t.vote(), "Host node signature problem");
    });

    it("vote only allows a change to the network's own setup stream", async () => {
      await refused(
        signWith(make("hybrid", change({}), { $o: { other: {} } }), 3).vote(),
        "Not the network setup stream"
      );
      await refused(
        signWith(make("hybrid", change({}), { $o: { netstream: {}, other: {} } }), 3).vote(),
        "Not the network setup stream"
      );
      await refused(signWith(make("hybrid", change({}), { $o: {} }), 3).vote(), "Not the network setup stream");
      const noNetwork = signWith(
        make("hybrid", change({}), { $o: { netstream: {} }, config: { neighbourhood: neighbourhood() } }),
        3
      );
      await refused(noNetwork.vote(), "Not the network setup stream");
    });

    it("commit applies the change to the ledger's section and asks for a reload", async () => {
      const activity = fakeActivity({ hybrid: hybridState() });
      const s = make("hybrid", change({ allow: ["k2"], minVersion: "5.3.0" }), {
        $o: { net: {} },
        streams: { net: activity },
      });
      await accepted(s.commit());
      const hybrid = activity.getState().hybrid;
      expect(hybrid.admission.allowlist).to.deep.equal(["k1", "k2"]);
      expect(hybrid.minVersion).to.equal("5.3.0");
      expect(s.configReload()).to.equal(true);
      expect(s.updateConfig).to.equal(true);
      expect(s.assertedHybrid).to.equal(true);
      expect(s.config.network).to.equal("netstream@2-abc");
    });

    it("commit refuses a change the section cannot take, leaving state untouched", async () => {
      const noSection = fakeActivity({});
      const a = make("hybrid", change({ minVersion: "5.3.0" }), { $o: { net: {} }, streams: { net: noSection } });
      await refused(a.commit(), "Network has no hybrid section");
      expect(a.updateConfig).to.equal(false);

      const open = fakeActivity({ hybrid: { ...hybridState(), admission: "open" } });
      const b = make("hybrid", change({ deny: ["k1"] }), { $o: { net: {} }, streams: { net: open } });
      await refused(b.commit(), "Admission is open, there is no allowlist to deny");
      expect(b.configReload()).to.equal(false);
    });
  });

  describe("postProcess", () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-post-"));
      file = path.join(dir, "config.json");
      fs.writeFileSync(file, '{"original":true}');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const config = () => ({
      __filename: file,
      neighbourhood: [1],
      consensus: { a: 1 },
      security: { b: 2 },
      hybrid: { c: 3 },
      db: { url: "x" },
      network: "netstream@2-abc",
    });

    it("does nothing when the config was not changed", async () => {
      const s = make("add", {}, { config: config() });
      expect(await s.postProcess(true, "n")).to.equal(true);
      expect(fs.readFileSync(file, "utf8")).to.equal('{"original":true}');
      expect(fs.existsSync(file + ".bak")).to.equal(false);
    });

    it("backs the file up and writes the config without what now lives on the ledger", async () => {
      const s = make("add", {}, { config: config() });
      s.updateConfig = true;
      expect(await s.postProcess(true, "n")).to.equal(true);
      expect(fs.readFileSync(file + ".bak", "utf8")).to.equal('{"original":true}');
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).to.deep.equal({
        hybrid: { c: 3 },
        db: { url: "x" },
        network: "netstream@2-abc",
      });
    });

    it("also drops the hybrid section once it has been asserted to the ledger", async () => {
      const s = make("assert", {}, { config: config() });
      s.updateConfig = true;
      s.assertedHybrid = true;
      await s.postProcess(true, "n");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).to.deep.equal({
        db: { url: "x" },
        network: "netstream@2-abc",
      });
    });
  });

  describe("helpers", () => {
    const s: any = Object.create(Setup.prototype);

    it("deepArrayEq compares lengths and members regardless of order", () => {
      expect(s.deepArrayEq([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }])).to.equal(true);
      expect(s.deepArrayEq([{ a: 1 }], [{ a: 1 }, { b: 2 }])).to.equal(false);
      expect(s.deepArrayEq([], [])).to.equal(true);
    });

    // BUG (not asserted, see PR): deepArrayEq only checks that every member
    // of a exists in b, so [{a:1},{a:1}] equals [{a:1},{b:2}]. The correct
    // answer is false because b has a member a lacks. Not asserted here.
    // Likewise deepEq compares ok(a).length with itself, so an extra key on
    // a is never noticed (it is also unused).

    it("arrayEq finds a structurally equal member", () => {
      expect(s.arrayEq({ a: [1] }, [{ x: 1 }, { a: [1] }])).to.equal(true);
      expect(s.arrayEq({ a: [2] }, [{ x: 1 }, { a: [1] }])).to.equal(false);
    });

    it("convertArray accepts arrays and strings and turns anything else into none", () => {
      const list = ["a"];
      expect(s.convertArray(list)).to.equal(list);
      expect(s.convertArray("a")).to.deep.equal(["a"]);
      expect(s.convertArray(undefined)).to.deep.equal([]);
      expect(s.convertArray({})).to.deep.equal([]);
    });

    it("deepEq compares nested values", () => {
      expect(s.deepEq({ a: { b: 1 } }, { a: { b: 1 } })).to.equal(true);
      expect(s.deepEq({ a: { b: 1 } }, { a: { b: 2 } })).to.equal(false);
      expect(s.deepEq(1, 1)).to.equal(true);
      expect(s.deepEq(1, 2)).to.equal(false);
    });
  });
});
