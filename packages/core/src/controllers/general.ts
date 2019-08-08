/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
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
import { readFileSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { IActiveHttpIncoming } from "@activeledger/httpd";

/**
 * API Welcome Message
 *
 * @export
 * @returns
 */
export function welcome() {
  return "Welcome to Activeledger Core";
}

/**
 * Responds to specific CORS request
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
export function options(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): void {
  // Default Allow CORS
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

/**
 * Return OpenAPI File (Swagger)
 *
 * @export
 * @returns {Buffer}
 */
export function openApi(): Buffer {
  return readFileSync(__dirname + "/../openapi.json");
}

/**
 * Redirect to Explorer
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
export function explorer(
  incoming: IActiveHttpIncoming,
  req: IncomingMessage,
  res: ServerResponse
): object {
  res.statusCode = 301;
  res.setHeader("Location", `https://developers.activeledger.io/explorer?url=http://${req.headers["host"]}/openapi.json`);
  return {};
}
