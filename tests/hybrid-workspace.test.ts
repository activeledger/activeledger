import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepareWorkspace, resolveDefaultContracts, resolveModulesDir } from "../packages/hybrid/src/workspace";

describe("hybrid workspace", () => {
  it("finds the modules directory and the compiled default contracts", () => {
    expect(fs.existsSync(path.join(resolveModulesDir(), "@activeledger/activecontracts"))).to.equal(true);
    expect(fs.existsSync(path.join(resolveDefaultContracts(), "onboard.js"))).to.equal(true);
  });

  it("creates both directories with working node_modules links and the default contracts", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-ws-"));
    prepareWorkspace(cwd);
    for (const dir of ["contracts", "default_contracts"]) {
      expect(fs.existsSync(path.join(cwd, dir, "node_modules/@activeledger/activecontracts/package.json")), dir).to.equal(true);
    }
    for (const file of ["contract.js", "namespace.js", "onboard.js", "setup.js", "hybrid.js"]) {
      expect(fs.existsSync(path.join(cwd, "default_contracts", file)), file).to.equal(true);
    }
    expect(fs.readdirSync(path.join(cwd, "default_contracts")).filter((f) => !f.endsWith(".js") && f !== "node_modules")).to.deep.equal([]);
  });

  it("can run again over an existing workspace and refreshes the default contracts", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-ws-"));
    prepareWorkspace(cwd);
    fs.writeFileSync(path.join(cwd, "default_contracts/onboard.js"), "stale");
    prepareWorkspace(cwd);
    expect(fs.readFileSync(path.join(cwd, "default_contracts/onboard.js"), "utf8")).to.not.equal("stale");
  });
});
