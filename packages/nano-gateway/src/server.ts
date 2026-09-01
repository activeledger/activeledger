/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { ActiveHttpd, IActiveHttpIncoming } from "@activeledger/httpd";
import { ActiveDSConnect, ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { Allowlist } from "./allowlist";
import { getStream, getStreams } from "./routes/stream";
import { getTransaction } from "./routes/tx";
import { subscribe, IHttpdRequest } from "./routes/subscribe";
import { IWritableHttpResponse } from "./sse";

export class NanoGatewayServer {
  private httpServer = new ActiveHttpd();
  private db: ActiveDSConnect;
  private allowlist: Allowlist;

  constructor() {
    const db = ActiveOptions.get<{ url: string; database: string }>("db", false as unknown as { url: string; database: string });
    this.db = new ActiveDSConnect(`${db.url}/${db.database}`);

    const gatewayConfig = ActiveOptions.get<{ allowlist: string; authWindowSeconds: number; heartbeatSeconds: number }>(
      "nanoGateway",
      { allowlist: "./nano-allowlist.json", authWindowSeconds: 60, heartbeatSeconds: 5 }
    );
    this.allowlist = new Allowlist(gatewayConfig.allowlist);

    this.httpServer.use("/", "GET", () => ({
      status: "ok",
      service: "nano-gateway",
      approvedNanos: this.allowlist.list().length,
    }));

    this.httpServer.use("/api/stream", "POST", (incoming: IActiveHttpIncoming) => getStreams(incoming, this.db));
    this.httpServer.use("/api/stream/*", "GET", (incoming: IActiveHttpIncoming) => getStream(incoming, this.db));
    this.httpServer.use("/api/tx/*", "GET", (incoming: IActiveHttpIncoming) => getTransaction(incoming, this.db));

    this.httpServer.use(
      "/api/activity/subscribe",
      "POST",
      (incoming: IActiveHttpIncoming, req: IHttpdRequest, res: IWritableHttpResponse) =>
        subscribe(incoming, req, res, {
          db: this.db,
          allowlist: this.allowlist,
          authWindowSeconds: gatewayConfig.authWindowSeconds,
          heartbeatSeconds: gatewayConfig.heartbeatSeconds,
        })
    );
  }

  public start(enableLogs = false): void {
    const [, port] = ActiveOptions.get<string>("host", ":5270").split(":");
    this.httpServer.listen(parseInt(port, 10), enableLogs);
    ActiveLogger.info(`nano-gateway listening on 0.0.0.0:${port} (${this.allowlist.list().length} approved nanos)`);
  }
}
