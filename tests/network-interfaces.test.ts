import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveInterfaces } from "../packages/network/src/network/utils";

// ActiveInterfaces caches its result in private statics and reads the live
// argv/config objects, so each test resets the cache and swaps those in.
describe("ActiveInterfaces binding details", () => {
  // Other suites may replace these objects, so always fetch them fresh
  const argvNow = (): any => ActiveOptions.fetch(true);
  const configNow = (): any => ActiveOptions.fetch(false);
  let savedArgv: any;
  let savedConfig: any;

  const reset = () => {
    (ActiveInterfaces as any).bindingHost = undefined;
    (ActiveInterfaces as any).bindingPort = undefined;
  };
  const setup = (a: any, c: any) => {
    const argv = argvNow();
    const config = configNow();
    for (const k of Object.keys(argv)) delete argv[k];
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(argv, a);
    Object.assign(config, c);
    reset();
  };

  beforeEach(() => {
    savedArgv = { ...argvNow() };
    savedConfig = { ...configNow() };
  });

  afterEach(() => {
    setup(savedArgv, savedConfig);
  });

  it("reads host and port from a host:port config string", () => {
    setup({ _: [] }, { host: "10.1.2.3:6000" });
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("10.1.2.3");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6000);
  });

  it("falls back to the argv port when the host has no port", () => {
    setup({ _: [], port: 7000 }, { host: "10.1.2.3" });
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("10.1.2.3");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(7000);
  });

  it("defaults to 5260 when neither host string nor argv gives a port", () => {
    setup({ _: [] }, { host: "10.1.2.3" });
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(5260);
  });

  it("prefers the config host over the argv host", () => {
    setup({ _: [], host: "1.1.1.1:1111" }, { host: "2.2.2.2:2222" });
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("2.2.2.2");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(2222);
  });

  it("uses the argv host when config has none", () => {
    setup({ _: [], host: "1.1.1.1:1111" }, {});
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("1.1.1.1");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(1111);
  });

  it("throws when neither host nor port is configured", () => {
    setup({ _: [] }, {});
    expect(() => ActiveInterfaces.getBindingDetails("host")).to.throw(
      "IP:Port Binding not found"
    );
  });

  it("caches the first answer", () => {
    setup({ _: [] }, { host: "10.1.2.3:6000" });
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("10.1.2.3");
    configNow().host = "9.9.9.9:9999";
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("10.1.2.3");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6000);
  });
});
