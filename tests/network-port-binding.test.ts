import { ActiveInterfaces } from "../packages/network/src/network/utils";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";

// ActiveInterfaces caches what it finds and ActiveOptions hands out its live
// objects, so every test sets what it needs and puts everything back.
describe("ActiveInterfaces binding (Activenetwork)", () => {
  // Fetched fresh each time: other tests replace these objects
  let argv: any;
  let config: any;
  let saved: any;
  const iface = ActiveInterfaces as any;

  const put = (obj: any, key: string, value: any) => {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  };

  const reset = () => {
    iface.bindingHost = undefined;
    iface.bindingPort = undefined;
  };

  beforeEach(() => {
    argv = ActiveOptions.fetch(true);
    config = ActiveOptions.fetch(false);
    saved = {
      argvHost: argv.host,
      argvPort: argv.port,
      configHost: config.host,
    };
    reset();
    delete argv.host;
    delete argv.port;
    delete config.host;
  });

  afterEach(() => {
    reset();
    put(argv, "host", saved.argvHost);
    put(argv, "port", saved.argvPort);
    put(config, "host", saved.configHost);
  });

  it("uses the port in the host string as a number", () => {
    config.host = "10.0.0.1:6001";
    expect(ActiveInterfaces.getBindingDetails("host")).to.equal("10.0.0.1");
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6001);
  });

  it("converts a string --port to a number when the host has no port", () => {
    config.host = "10.0.0.1";
    argv.port = "6000";
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6000);
  });

  it("defaults to 5260 when neither host string nor --port has a port", () => {
    config.host = "10.0.0.1";
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(5260);
  });

  it("accepts --port alone as a number and caches it", () => {
    argv.port = "6000";
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6000);

    // Found once: a later change to the arguments must not be re-read
    argv.port = "7000";
    expect(ActiveInterfaces.getBindingDetails("port", true)).to.equal(6000);
  });

  it("throws when nothing is configured", () => {
    expect(() => ActiveInterfaces.getBindingDetails("port", true)).to.throw();
  });
});
