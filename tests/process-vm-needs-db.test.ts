import { Process } from "../packages/protocol/src/protocol/process";
import { expect } from "chai";
import "mocha";

// The contract VM keeps the connections it is built with for the life of the worker. A transaction that
// reaches a worker before its setup (no database yet) must not be the one that builds it, or every later
// contract in that worker fails to write its events ("Cannot read properties of undefined (reading 'post')").
describe("Process: the general contract VM is never built without a database (Activeprotocol)", () => {
  const realVM = (Process as any).generalContractVM;
  afterEach(() => {
    (Process as any).generalContractVM = realVM;
  });

  const build = (db: any, dbev: any) =>
    new Process(
      { $umid: "u", $origin: "o", $nodes: {}, $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} }, $sigs: {} } as any,
      "localhost:5259",
      "self",
      { reference: "right", knock: () => new Promise(() => undefined) } as any,
      db,
      {} as any,
      dbev
    );

  it("does not build it from a caller with no connections, and builds it from the next one that has them", () => {
    (Process as any).generalContractVM = undefined;
    build(undefined, undefined);
    expect((Process as any).generalContractVM).to.equal(undefined);
    build({} as any, undefined);
    expect((Process as any).generalContractVM, "db but no event db").to.equal(undefined);
    build({} as any, { post: () => Promise.resolve({}) } as any);
    expect((Process as any).generalContractVM).to.not.equal(undefined);
  });

  it("keeps the one it has, whoever asks next", () => {
    (Process as any).generalContractVM = undefined;
    build({} as any, { post: () => Promise.resolve({}) } as any);
    const first = (Process as any).generalContractVM;
    build(undefined, undefined);
    expect((Process as any).generalContractVM).to.equal(first);
  });
});
