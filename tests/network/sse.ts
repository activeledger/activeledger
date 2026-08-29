/**
 * Minimal hand-rolled SSE client - deliberately not a new npm dependency,
 * matching how SSE was verified manually throughout the hpe-13/hpe-14
 * sessions (plain `http` + a small line parser). Connects to a node's
 * self-hosted storage engine's `/<database>/events` endpoint (see
 * storage.md on hpe-13 for the real, verified mechanism this targets).
 */

import * as http from "http";
import { URL } from "url";

export interface SSEEvent {
  id?: string;
  data: string;
}

export class SSEClient {
  private req?: http.ClientRequest;
  private buffer = "";
  private closed = false;
  private onEventHandlers: ((event: SSEEvent) => void)[] = [];

  constructor(private url: string) {}

  public onEvent(handler: (event: SSEEvent) => void): void {
    this.onEventHandlers.push(handler);
  }

  /** Resolves once the connection is open (headers received). */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = new URL(this.url);
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: "GET",
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`SSE connect failed: ${res.statusCode} for ${this.url}`));
            return;
          }
          res.on("data", (chunk: Buffer) => this.handleChunk(chunk.toString("utf8")));
          res.on("error", (e) => {
            if (!this.closed) reject(e);
          });
          resolve();
        }
      );
      req.on("error", (e) => {
        if (!this.closed) reject(e);
      });
      req.end();
      this.req = req;
    });
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.parseEvent(rawEvent);
    }
  }

  private parseEvent(raw: string): void {
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
      // ":\n\n" heartbeat comments and "event: message" lines are ignored -
      // we don't need to distinguish event types for this test.
    }
    if (dataLines.length === 0) return; // heartbeat, not a real event
    const event: SSEEvent = { id, data: dataLines.join("\n") };
    this.onEventHandlers.forEach((handler) => handler(event));
  }

  public close(): void {
    this.closed = true;
    this.req?.destroy();
  }
}
