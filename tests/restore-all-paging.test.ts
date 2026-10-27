import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";

// /a/all is how activerestore --full lists a neighbour's ledger, a page at a
// time, starting after the last id it was given.
describe("Endpoints.all - paging the ledger for a restore (Activerestore)", () => {
  const rows = (...ids: string[]) => ({ rows: ids.map((id) => ({ id, value: { rev: "1-a" } })) });
  const dbOf = (seen: any[], response: any) => ({ allDocs: async (o: any) => (seen.push(o), response) } as any);

  it("starts after the row the caller already has, and skips nothing else", async () => {
    const seen: any[] = [];
    await Endpoints.all(dbOf(seen, rows()), "X:stream");
    expect(seen[0]).to.include({ startkey: "X:stream", skip: 1, limit: 500 });
  });

  it("asks for the first page without a start", async () => {
    const seen: any[] = [];
    await Endpoints.all(dbOf(seen, rows()));
    expect(seen[0]).to.deep.equal({ limit: 500 });
  });

  it("leaves volatile rows out of the answer", async () => {
    const out: any = await Endpoints.all(dbOf([], rows("X", "X:stream", "X:volatile", "U:umid")));
    expect(out.content.map((r: any) => r.id)).to.deep.equal(["X", "X:stream", "U:umid"]);
  });
});
