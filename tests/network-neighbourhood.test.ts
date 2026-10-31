import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import "../packages/network/src/network/home";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { Neighbourhood } from "../packages/network/src/network/neighbourhood";

/**
 * The neighbourhood is the node's firewall: only hosts in it may knock, and
 * a host may only claim the reference it is registered under. Built from a
 * real config list, no sockets involved.
 */
describe("Neighbourhood", () => {
  const key = new ActiveCrypto.KeyPair("rsa").generate().pub.pkcs8pem;
  const entry = (host: string, port = 5260) => ({ host, port, identity: { type: "rsa", public: key } });
  const refOf = (host: string, port = 5260) => new Neighbour(host, port).reference;

  let savedHood: any;
  let savedNetwork: any;
  let nh: Neighbourhood;

  beforeEach(() => {
    savedHood = ActiveOptions.get("neighbourhood", undefined);
    savedNetwork = ActiveOptions.get("network", undefined);
    ActiveOptions.set("network", "");
    ActiveOptions.set("neighbourhood", [entry("10.1.0.1"), entry("10.1.0.2"), entry("10.1.0.3")]);
    nh = new Neighbourhood();
  });

  afterEach(() => {
    ActiveOptions.set("neighbourhood", savedHood);
    ActiveOptions.set("network", savedNetwork);
  });

  it("refuses to start without a neighbourhood in the config", () => {
    ActiveOptions.set("neighbourhood", false);
    expect(() => new Neighbourhood()).to.throw();
  });

  it("counts and indexes its neighbours by reference", () => {
    expect(nh.count()).to.equal(3);
    expect(nh.keys()).to.have.length(3);
    expect(nh.exists(refOf("10.1.0.1"))).to.equal(true);
    expect(nh.exists("nope")).to.equal(false);
    expect(nh.get(refOf("10.1.0.1")).getAddress().host).to.equal("10.1.0.1");
    expect(nh.get("nope")).to.equal(null);
    expect(Object.keys(nh.get())).to.have.length(3);
  });

  it("picks a random neighbour, and never the one to skip", () => {
    const skip = nh.get(refOf("10.1.0.2"));
    for (let i = 0; i < 50; i++) {
      expect(nh.get(true, skip).reference).to.not.equal(skip.reference);
    }
    expect(nh.exists(nh.get(true).reference)).to.equal(true);
  });

  describe("firewall", () => {
    it("admits known hosts including IPv4-mapped IPv6 notation, and refuses unknown ones", () => {
      expect(nh.checkFirewall("10.1.0.1")).to.equal(true);
      expect(nh.checkFirewall("::ffff:10.1.0.2")).to.equal(true);
      expect(nh.checkFirewall("10.9.9.9")).to.equal(false);
    });

    it("binds a host to the node reference it claims", () => {
      expect(nh.checkFirewall("10.1.0.1", refOf("10.1.0.1"))).to.equal(true);
      expect(nh.checkFirewall("10.1.0.1", refOf("10.1.0.2"))).to.equal(false);
      expect(nh.checkFirewall("10.9.9.9", refOf("10.1.0.1"))).to.equal(false);
    });
  });

  describe("reset()", () => {
    it("stops neighbours that left, keeps and revives those that stay, and adds new ones", () => {
      nh.get(refOf("10.1.0.1")).graceStop = true;
      nh.reset([entry("10.1.0.1"), entry("10.1.0.2"), entry("10.1.0.4")]);

      expect(nh.get(refOf("10.1.0.1")).graceStop).to.equal(false);
      expect(nh.get(refOf("10.1.0.3")).graceStop).to.equal(true);
      expect(nh.exists(refOf("10.1.0.4"))).to.equal(true);
      expect(nh.count()).to.equal(4);
      expect(nh.keys()).to.have.length(4);
    });
  });

  describe("knockAll()", () => {
    it("knocks only neighbours that are home unless forced, collecting data and failures", async () => {
      const all = nh.get();
      const [a, b, c] = Object.keys(all);
      const calls: string[] = [];
      all[a].isHome = true;
      all[b].isHome = true;
      all[c].isHome = false;
      all[a].knock = async () => { calls.push(a); return { data: "a" }; };
      all[b].knock = async () => { calls.push(b); throw new Error("down"); };
      all[c].knock = async () => { calls.push(c); return { data: "c" }; };

      const results = await nh.knockAll("status");
      expect(results).to.have.length(2);
      expect(results).to.include("a");
      expect(results).to.deep.include({ error: true, from: b });
      expect(calls).to.not.include(c);

      const forced = await nh.knockAll("status", undefined, true);
      expect(forced).to.have.length(3);
      expect(forced).to.include("c");
    });
  });
});
