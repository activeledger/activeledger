import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveHttpd } from "@activeledger/httpd";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";

describe("nano-gateway index entrypoint", () => {
  const indexPath = require.resolve("../packages/nano-gateway/src/index");
  const proto: any = ActiveHttpd.prototype;
  const logger: any = ActiveLogger;
  const origArgv = process.argv;
  // parseConfig() replaces the config object, and other test files hold a
  // reference to the original: put the very same objects back afterwards.
  const origConfig = (ActiveOptions as any).config;
  const origCliArgv = (ActiveOptions as any).argv;
  const origGlobalConfig = (global as any).config;
  const origGlobalArgv = (global as any).argv;
  const origExit = process.exit;
  const orig = { listen: proto.listen, use: proto.use, info: logger.info, fatal: logger.fatal, debug: logger.enableDebug };
  let dir: string;
  let listened: any[];
  let infos: string[];
  let fatals: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanogw-idx-"));
    listened = [];
    infos = [];
    fatals = [];
    proto.listen = (...a: any[]) => listened.push(a);
    proto.use = () => {};
    logger.info = (m: string) => infos.push(m);
    logger.fatal = (m: string) => fatals.push(m);
    (process as any).exit = (code: number) => { throw new Error(`exit:${code}`); };
  });
  afterEach(() => {
    proto.listen = orig.listen;
    proto.use = orig.use;
    logger.info = orig.info;
    logger.fatal = orig.fatal;
    logger.enableDebug = orig.debug;
    (process as any).exit = origExit;
    process.argv = origArgv;
    (ActiveOptions as any).config = origConfig;
    (ActiveOptions as any).argv = origCliArgv;
    (global as any).config = origGlobalConfig;
    (global as any).argv = origGlobalArgv;
    delete require.cache[indexPath];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (cfgPath: string) => {
    process.argv = [process.argv[0], "x", "--config", cfgPath];
    delete require.cache[indexPath];
    require(indexPath);
  };

  it("with no config file, writes the default config and a default empty allowlist, then starts", () => {
    const cfg = path.join(dir, "config.json");
    // The default config has a db section, so startup proceeds; allowlist is
    // relative to cwd so point it at the temp dir by pre-writing a config.
    const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/nano-gateway/src/default.config.json"), "utf8"));
    run(cfg);
    expect(JSON.parse(fs.readFileSync(cfg, "utf8"))).to.deep.equal(defaults);
    expect(infos[0]).to.equal(`Created nano-gateway config file at ${cfg}`);
    // default allowlist path ./nano-allowlist.json is created in cwd; remove it
    const al = path.resolve("./nano-allowlist.json");
    expect(fs.readFileSync(al, "utf8")).to.equal("[]\n");
    fs.rmSync(al);
    expect(listened).to.deep.equal([[5270, true]]);
  });

  it("with an existing config and allowlist, does not rewrite either and starts on the host port", () => {
    const cfg = path.join(dir, "config.json");
    const al = path.join(dir, "al.json");
    fs.writeFileSync(al, '[{"identity":"a"}]');
    const body = JSON.stringify({ db: { url: "http://h:1", database: "d" }, nanoGateway: { allowlist: al }, host: ":6999" });
    fs.writeFileSync(cfg, body);
    run(cfg);
    expect(fs.readFileSync(cfg, "utf8")).to.equal(body);
    expect(fs.readFileSync(al, "utf8")).to.equal('[{"identity":"a"}]');
    expect(listened).to.deep.equal([[6999, false]]);
    expect(logger.enableDebug).to.equal(false);
    expect(infos.some((m) => m.startsWith("Created"))).to.equal(false);
  });

  it("creates the configured allowlist as [] when missing, and honours debug", () => {
    const cfg = path.join(dir, "config.json");
    const al = path.join(dir, "new-al.json");
    fs.writeFileSync(cfg, JSON.stringify({ db: { url: "u", database: "d" }, nanoGateway: { allowlist: al }, host: ":7000", debug: true }));
    run(cfg);
    expect(fs.readFileSync(al, "utf8")).to.equal("[]\n");
    expect(infos).to.include(`Created empty allowlist at ${al} - no nanos can connect until you add identities to it`);
    expect(logger.enableDebug).to.equal(true);
    expect(listened).to.deep.equal([[7000, true]]);
  });

  it("exits with a fatal log when the config has no db", () => {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ host: ":7001" }));
    expect(() => run(cfg)).to.throw("exit:1");
    expect(fatals).to.deep.equal(["Configuration file incomplete - no db connection configured"]);
    expect(listened).to.deep.equal([]);
  });
});
