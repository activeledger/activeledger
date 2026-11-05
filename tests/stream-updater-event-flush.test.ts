import { expect } from "chai";
import "mocha";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

/**
 * The event row of an answered transaction is posted after the answer. A worker
 * that is told to exit (its node is being stopped) must give those posts a
 * moment to reach storage first, but never hang on one that does not.
 */
describe("StreamUpdater.flushEventPosts", () => {
  const pending = (): Set<Promise<unknown>> => (StreamUpdater as any).pendingEventPosts;
  afterEach(() => pending().clear());

  it("returns at once when nothing is pending", async () => {
    const started = Date.now();
    await StreamUpdater.flushEventPosts(5000);
    expect(Date.now() - started).to.be.lessThan(200);
  });

  it("waits for a post that is still on its way", async () => {
    let done = false;
    const post = new Promise<void>((resolve) => setTimeout(() => { done = true; resolve(); }, 60));
    pending().add(post);
    await StreamUpdater.flushEventPosts(5000);
    expect(done).to.equal(true);
  });

  it("gives up after the timeout rather than hang on a post that never finishes", async () => {
    pending().add(new Promise<void>(() => undefined));
    const started = Date.now();
    await StreamUpdater.flushEventPosts(120);
    const took = Date.now() - started;
    expect(took).to.be.within(100, 1000);
  });
});
