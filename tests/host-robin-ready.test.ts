import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

// Which worker the host hands work to: not one still setting up, while another is ready
describe("Host worker choice (getRobin) and workers still setting up", () => {
  const worker = (pid: number, over: any = {}): any => ({ pid, stop: false, ...over });
  const hostWith = (processors: any[]): any => {
    const host = Object.create(Host.prototype);
    host.processors = processors;
    host.processorIterator = processors[Symbol.iterator]();
    return host;
  };
  const picks = (host: any, n: number) => Array.from({ length: n }, () => host.getRobin().pid);

  it("skips a worker that is not ready while another is, and keeps the rotation fair among the ready ones", () => {
    const host = hostWith([worker(1), worker(2, { ready: true }), worker(3, { ready: true })]);
    expect(picks(host, 6)).to.deep.equal([2, 3, 2, 3, 2, 3]);
  });

  it("uses a worker that is not ready when none is (it holds the work until its setup is done)", () => {
    const host = hostWith([worker(1), worker(2)]);
    expect(picks(host, 4)).to.deep.equal([1, 2, 1, 2]);
  });

  it("goes back to a worker as soon as it says it is ready", () => {
    const late = worker(1);
    const host = hostWith([late, worker(2, { ready: true })]);
    expect(picks(host, 2)).to.deep.equal([2, 2]);
    late.ready = true;
    expect(picks(host, 4)).to.deep.equal([1, 2, 1, 2]);
  });

  it("never picks a stopped worker, ready or not", () => {
    const host = hostWith([worker(1, { ready: true, stop: true }), worker(2), worker(3, { ready: true })]);
    expect(picks(host, 4)).to.deep.equal([3, 3, 3, 3]);
  });

  it("does not count a stopped ready worker as a reason to skip one that is not ready", () => {
    const host = hostWith([worker(1, { ready: true, stop: true }), worker(2)]);
    expect(picks(host, 2)).to.deep.equal([2, 2]);
  });
});
