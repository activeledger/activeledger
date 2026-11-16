import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import { us_socket_local_port } from "uWebSockets.js";
import { ActiveHttpd } from "../packages/httpd/src/httpd";

/**
 * Edges a mutation pass over httpd.ts found nothing checking: which route
 * wins when several match (a method-specific one over ALL, the more specific
 * pattern over a wildcard, whichever order they were registered in), and a
 * client that goes away before the answer is ready.
 */
describe("ActiveHttpd - edges the tests did not pin (Activehttpd)", () => {
  const get = (port: number, method: string, path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end();
    });

  const serve = async (register: (h: ActiveHttpd, tag: (n: string) => any) => void) => {
    const httpd = new ActiveHttpd();
    register(httpd, (name) => async () => ({ route: name }));
    httpd.listen(0);
    await new Promise((r) => setTimeout(r, 150));
    return { httpd, port: us_socket_local_port((httpd as any).listenSocket) };
  };
  const route = async (port: number, method: string, path: string) => {
    const r = await get(port, method, path);
    return r.status === 200 ? JSON.parse(r.body).route : r.status;
  };

  describe("when two routes match the same request", () => {
    const orders: [string, (h: ActiveHttpd, t: any) => void][] = [
      ["method route first", (h, t) => (h.use("/n/b", "GET", t("get")), h.use("/n/b", "ALL", t("all")))],
      ["ALL route first", (h, t) => (h.use("/n/b", "ALL", t("all")), h.use("/n/b", "GET", t("get")))],
    ];
    for (const [name, register] of orders) {
      it(`a method specific route beats ALL, and ALL answers the other methods (${name})`, async () => {
        const { httpd, port } = await serve(register);
        try {
          expect(await route(port, "GET", "/n/b")).to.equal("get");
          expect(await route(port, "POST", "/n/b")).to.equal("all");
        } finally {
          httpd.shutdown(false);
        }
      });
    }

    const mixed: [string, (h: ActiveHttpd, t: any) => void][] = [
      ["specific ALL registered first", (h, t) => (h.use("/m/b", "ALL", t("specific")), h.use("/m/*", "GET", t("wild")))],
      ["wildcard method route registered first", (h, t) => (h.use("/m/*", "GET", t("wild")), h.use("/m/b", "ALL", t("specific")))],
    ];
    for (const [name, register] of mixed) {
      it(`the more specific pattern beats a wildcard even when the wildcard names the method (${name})`, async () => {
        const { httpd, port } = await serve(register);
        try {
          expect(await route(port, "GET", "/m/b")).to.equal("specific");
          expect(await route(port, "GET", "/m/other")).to.equal("wild");
          expect(await route(port, "POST", "/m/other")).to.equal(404);
        } finally {
          httpd.shutdown(false);
        }
      });
    }
  });

  describe("several routes of different weight and method, registered in every order", () => {
    const defs: [string, string, string][] = [
      ["/p/*", "GET", "wild"],
      ["/p/b", "ALL", "specific"],
      ["/p/**", "ALL", "deep"],
      ["/p/b", "GET", "exact-get"],
    ];
    const permutations = <T>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));
    const without = (skip: number) => defs.filter((_, i) => i !== skip);

    it("always picks the most specific route, and a method route over ALL of the same weight", async function () {
      this.timeout(30000);
      for (const order of permutations(defs)) {
        const { httpd, port } = await serve((h, t) => order.forEach(([path, method, name]) => h.use(path, method as any, t(name))));
        try {
          const tag = order.map((d) => d[2]).join(",");
          expect(await route(port, "GET", "/p/b"), tag).to.equal("exact-get");
          expect(await route(port, "POST", "/p/b"), tag).to.equal("specific");
          expect(await route(port, "GET", "/p/zzz"), tag).to.equal("wild");
          expect(await route(port, "POST", "/p/zzz"), tag).to.equal("deep");
        } finally {
          httpd.shutdown(false);
        }
      }
    });

    it("picks the specific ALL route over a wildcard method route when those are all there is", async () => {
      for (const order of permutations(without(3).slice(0, 2))) {
        const { httpd, port } = await serve((h, t) => order.forEach(([path, method, name]) => h.use(path, method as any, t(name))));
        try {
          expect(await route(port, "GET", "/p/b"), order.map((d) => d[2]).join(",")).to.equal("specific");
        } finally {
          httpd.shutdown(false);
        }
      }
    });
  });

  it("keeps serving when a client goes away before the answer is ready", async () => {
    const stray: any[] = [];
    const onRejection = (e: any) => stray.push(e);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onRejection);
    const { httpd, port } = await serve((h) => {
      h.use("/slow", "GET", async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { slow: true };
      });
      h.use("/fast", "GET", async () => ({ fast: true }));
    });
    try {
      await new Promise<void>((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => {
          s.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
          setTimeout(() => (s.destroy(), resolve()), 30);
        });
      });
      await new Promise((r) => setTimeout(r, 300));
      expect((await get(port, "GET", "/fast")).status).to.equal(200);
      expect(stray).to.deep.equal([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onRejection);
      httpd.shutdown(false);
    }
  });
});
