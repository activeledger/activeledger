/**
 * Small HTTP helpers for the live network test - plain transaction
 * submission against a node's root, and direct reads/writes against a
 * node's own storage engine (used by the SPI test to desync one node's
 * local copy of a stream without going through consensus at all).
 */

import * as http from "http";
import { URL } from "url";

export function requestJson(
  url: string,
  method: string,
  body?: unknown,
  timeoutMs = 20000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        timeout: timeoutMs,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : undefined,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Non-JSON response from ${url}: ${responseBody.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Same as requestJson(), but also surfaces the HTTP status code - needed
 * for tests that assert a request was *rejected* (e.g. the storage
 * engine's /_backup and /_restore path-validation), where the error
 * response body alone (often just "{}") doesn't distinguish success from
 * failure the way requestJson()'s plain body-only resolution does.
 */
export function requestJsonWithStatus(
  url: string,
  method: string,
  body?: unknown,
  timeoutMs = 20000
): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        timeout: timeoutMs,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : undefined,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            resolve({ statusCode: res.statusCode || 0, data: parsed });
          } catch (e) {
            reject(new Error(`Non-JSON response from ${url}: ${responseBody.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Submits a transaction to a node's root endpoint. */
export function submit(baseUrl: string, tx: unknown): Promise<any> {
  return requestJson(baseUrl + "/", "POST", tx);
}

/** Reads a document directly from a node's own storage engine. */
export function storageGet(
  storageUrl: string,
  streamId: string,
  database = "activeledger"
): Promise<any> {
  return requestJson(`${storageUrl}/${database}/${encodeURIComponent(streamId)}`, "GET");
}

/**
 * Writes a document directly to a node's own storage engine, bypassing
 * consensus/gossip entirely - LevelMe.post()/put() recompute a fresh
 * revision from whatever's currently stored regardless of the _rev in the
 * body (new_edits defaults to true), so this is enough to desync a single
 * node's local copy of a stream from the rest of the network for the SPI
 * test.
 */
export function storagePut(
  storageUrl: string,
  streamId: string,
  doc: unknown,
  database = "activeledger"
): Promise<any> {
  return requestJson(`${storageUrl}/${database}/${encodeURIComponent(streamId)}`, "PUT", doc);
}
