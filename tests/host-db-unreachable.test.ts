import { expect } from "chai";
import "mocha";
import { ActiveLogger } from "@activeledger/activelogger";
import { Host } from "../packages/network/src/network/host";

/**
 * The start-up check that the three databases answer is not awaited, so a
 * database that is down must be logged, not left as an unhandled rejection.
 */
describe("Host.dbUnreachable (start-up database check)", () => {
  it("logs a warning with the reason and does not throw", () => {
    const warned: string[] = [];
    const original = ActiveLogger.warn;
    (ActiveLogger as any).warn = (m: string) => void warned.push(m);
    try {
      Host.dbUnreachable(new Error("ECONNREFUSED"));
      Host.dbUnreachable("plain text");
    } finally {
      (ActiveLogger as any).warn = original;
    }
    expect(warned).to.have.length(2);
    expect(warned[0]).to.contain("ECONNREFUSED");
    expect(warned[1]).to.contain("plain text");
  });

  it("is what the start-up checks use, so a rejected info() is handled", async () => {
    const original = ActiveLogger.warn;
    (ActiveLogger as any).warn = () => undefined;
    try {
      await Promise.reject(new Error("down")).catch(Host.dbUnreachable);
    } finally {
      (ActiveLogger as any).warn = original;
    }
  });
});
