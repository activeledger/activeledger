import { expect } from "chai";
import "mocha";
import { PhysicalCores } from "../packages/network/src/network/cpus";

// The mutable CommonJS modules (not import namespaces) are patched.
const os: any = require("os");
const child: any = require("child_process");

// PhysicalCores shells out per platform, so os.platform, os.cpus and
// child.execSync are swapped for fakes and restored after each test. The
// result cache is private static state and is cleared around each test.
describe("PhysicalCores", () => {
  const realPlatform = os.platform;
  const realCpus = os.cpus;
  const realExec = child.execSync;
  let commands: string[];

  const use = (platform: string, out = "") => {
    (os as any).platform = () => platform;
    (child as any).execSync = (cmd: string) => {
      commands.push(cmd);
      return out;
    };
  };

  beforeEach(() => {
    commands = [];
    (PhysicalCores as any).coreCount = null;
  });

  afterEach(() => {
    (os as any).platform = realPlatform;
    (os as any).cpus = realCpus;
    (child as any).execSync = realExec;
    (PhysicalCores as any).coreCount = null;
  });

  it("linux: parses the unique core count from lscpu", () => {
    use("linux", "6\n");
    expect(PhysicalCores.count()).to.equal(6);
    expect(commands).to.have.length(1);
    expect(commands[0]).to.contain("lscpu");
  });

  it("darwin: parses sysctl hw.physicalcpu_max", () => {
    use("darwin", "10\n");
    expect(PhysicalCores.count()).to.equal(10);
    expect(commands[0]).to.contain("hw.physicalcpu_max");
  });

  it("win32: sums NumberOfCores across sockets and caches it", () => {
    use("win32", "NumberOfCores  " + os.EOL + "4  " + os.EOL + "8  " + os.EOL);
    expect(PhysicalCores.count()).to.equal(12);
    expect(PhysicalCores.count()).to.equal(12);
    expect(commands).to.have.length(1);
  });

  it("other platforms: counts distinct core_id values", () => {
    use("freebsd");
    (os as any).cpus = () => [
      { model: "x", core_id: 0 },
      { model: "x", core_id: 0 },
      { model: "x", core_id: 1 },
    ];
    expect(PhysicalCores.count()).to.equal(2);
    expect(commands).to.have.length(0);
  });

  it("other platforms without core_id: halves Intel threads, keeps others", () => {
    use("freebsd");
    (os as any).cpus = () => [
      { model: "Intel(R) Core" },
      { model: "Intel(R) Core" },
      { model: "Intel(R) Core" },
      { model: "Intel(R) Core" },
    ];
    expect(PhysicalCores.count()).to.equal(2);
    (PhysicalCores as any).coreCount = null;
    (os as any).cpus = () => [{ model: "ARM" }, { model: "ARM" }, { model: "ARM" }];
    expect(PhysicalCores.count()).to.equal(3);
  });

  it("returns the cached value without running anything", () => {
    use("linux", "99\n");
    (PhysicalCores as any).coreCount = 3;
    expect(PhysicalCores.count()).to.equal(3);
    expect(commands).to.have.length(0);
  });
});
