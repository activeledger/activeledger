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

import * as fs from "fs";
import { ActiveOptions, ActiveRequest } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";

/**
 * Changes to the on-ledger `hybrid` section (`hybrid allow|deny|admission|
 * min-version`). The section lives in the setup stream, so a change is a
 * `default/setup` `hybrid` transaction that more than half of the nodes must
 * sign, as for `approve` and `revoke`. One node can sign and submit alone on
 * a single node network; otherwise it writes the transaction to a file, each
 * other node adds its signature with `hybrid sign`, and `hybrid submit` sends
 * it.
 */
export interface HybridChange {
  admission?: "open" | "allowlist";
  allow?: string[];
  deny?: string[];
  minVersion?: string;
}

const config = (): { host: string; network: string } => {
  const file = ActiveOptions.get<string>("config", "./config.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    host: ActiveOptions.get<string>("host", "") || parsed.host,
    network: ActiveOptions.get<string>("network", "") || parsed.network || "",
  };
};

const identity = (): ActiveCrypto.KeyHandler =>
  JSON.parse(
    fs.readFileSync(ActiveOptions.get<string>("identity", "./.identity"), "utf8")
  );

const signer = (id: ActiveCrypto.KeyHandler) =>
  new ActiveCrypto.KeyPair("rsa", id.prv.pkcs8pem);

/**
 * A key as the allowlist holds it: the hash of a public key, taken from a
 * PEM, a file holding one, or a hash already.
 */
export const keyArgument = (arg: string): string => {
  if (/^[a-f0-9]{64}$/.test(arg)) return arg;
  const pem = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  if (pem.indexOf("-----BEGIN") === -1) {
    throw new Error("expected a key hash, a PEM public key or a file holding one");
  }
  return ActiveCrypto.keyHash(pem);
};

/** The signed request for a change, signed by this node */
export const buildChange = (change: HybridChange): any => {
  const { host, network } = config();
  if (!network) {
    throw new Error("The network has not been asserted to the ledger yet");
  }
  const id = identity();
  const tx = {
    $namespace: "default",
    $contract: "setup",
    $entry: "hybrid",
    $i: {
      suggester: { type: "rsa", publicKey: id.pub.pkcs8pem, change },
    },
    $o: { [network.split("@")[0]]: {} },
  };
  const signed = signer(id).sign(tx);
  return {
    $tx: tx,
    $selfsign: true,
    $sigs: { suggester: signed, [host]: signed },
  };
};

/** Add this node's signature to a request built by another node */
export const signChange = (request: any): any => {
  const { host } = config();
  request.$sigs[host] = signer(identity()).sign(request.$tx);
  return request;
};

/** Send a request to this node; resolves to the errors, if any */
export const submitChange = async (request: any): Promise<string[]> => {
  const { host } = config();
  const response: any = await ActiveRequest.send(`http://${host}`, "POST", [], request);
  return response.data?.$summary?.errors ?? [];
};

/** Signers so far, as host:port */
export const signers = (request: any): string[] =>
  Object.keys(request.$sigs).filter((k) => k !== "suggester");
