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

import { Standard, Activity, ActiveCrypto } from "@activeledger/activecontracts";
import { ActiveOptions, HybridConfig } from "@activeledger/activeoptions";

/**
 * Default Hybrid Registry contract
 *
 * Each hybrid registers its own key and endpoints into its own stream,
 * `activeledger.default.hybrid.<keyhash>`. The stream is seeded with the
 * keyhash, so its id is ActiveCrypto.hybridStreamId(key) and any node or
 * hybrid can find it from the key alone. There is no shared index stream, so
 * registrations never contend for one lock.
 *
 * Entries:
 *  register: self signed by the hybrid's key.
 *            $i: { <ref>: { type, publicKey, endpoints, label? } }
 *  update:   signed by the hybrid's key, as the stream's authority.
 *            $i: { <streamId>: { endpoints } }
 *  retire:   signed by the hybrid's key, as the stream's authority.
 *            $i: { <streamId>: {} }
 *
 * @export
 * @class Hybrid
 * @extends {Standard}
 */
export default class Hybrid extends Standard {
  /**
   * Build level from which the registry accepts anything. Below it a node
   * refuses every entry, the same as a node that has no registry, so a
   * half-upgraded network cannot diverge on it.
   *
   * @static
   */
  public static readonly BUILD = 40300;

  /**
   * Registry stream state type
   *
   * @static
   */
  public static readonly TYPE = "default.activeledger.hybrid";

  /**
   * Key types KeyPair can verify with
   *
   * @static
   */
  public static readonly KEY_TYPES = [
    "rsa",
    "secp256k1",
    "bitcoin",
    "ethereum",
    "ml-dsa-65",
    "falcon-512",
  ];

  /**
   * Limits, so a registration stays a small document
   *
   * @static
   */
  public static readonly MAX_ENDPOINTS = 8;
  public static readonly MAX_LABEL = 64;
  public static readonly MAX_KEY = 4096;

  //#region Validation (pure, no ledger access)

  /**
   * Validate a hybrid's public key and type. Returns the reason, or null.
   *
   * @static
   * @param {*} type
   * @param {*} publicKey
   * @returns {(string | null)}
   */
  public static validateKey(type: any, publicKey: any): string | null {
    if (typeof type !== "string" || Hybrid.KEY_TYPES.indexOf(type) === -1) {
      return "Unsupported key type";
    }
    if (
      typeof publicKey !== "string" ||
      !publicKey.length ||
      publicKey.length > Hybrid.MAX_KEY ||
      publicKey.indexOf("PRIVATE") !== -1
    ) {
      return "Invalid public key";
    }
    return null;
  }

  /**
   * Validate the endpoints list: [{transport:"p2p"|"http", host, port}].
   * Returns the reason, or null.
   *
   * @static
   * @param {*} endpoints
   * @returns {(string | null)}
   */
  public static validateEndpoints(endpoints: any): string | null {
    if (
      !Array.isArray(endpoints) ||
      !endpoints.length ||
      endpoints.length > Hybrid.MAX_ENDPOINTS
    ) {
      return `Endpoints must be 1 to ${Hybrid.MAX_ENDPOINTS} entries`;
    }

    const seen: string[] = [];
    for (const endpoint of endpoints) {
      if (
        !endpoint ||
        typeof endpoint !== "object" ||
        Array.isArray(endpoint) ||
        Object.keys(endpoint).some(
          (key) => ["transport", "host", "port"].indexOf(key) === -1
        )
      ) {
        return "Invalid endpoint";
      }
      if (endpoint.transport !== "p2p" && endpoint.transport !== "http") {
        return "Endpoint transport must be p2p or http";
      }
      if (!Hybrid.validHost(endpoint.host)) {
        return "Invalid endpoint host";
      }
      if (
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535
      ) {
        return "Invalid endpoint port";
      }
      const id = `${endpoint.transport}://${endpoint.host}:${endpoint.port}`;
      if (seen.indexOf(id) !== -1) return "Duplicate endpoint";
      seen.push(id);
    }
    return null;
  }

  /**
   * Validate an optional label. Returns the reason, or null.
   *
   * @static
   * @param {*} label
   * @returns {(string | null)}
   */
  public static validateLabel(label: any): string | null {
    if (label === undefined) return null;
    if (
      typeof label !== "string" ||
      !label.length ||
      label.length > Hybrid.MAX_LABEL ||
      /[\x00-\x1f\x7f]/.test(label)
    ) {
      return `Label must be 1 to ${Hybrid.MAX_LABEL} printable characters`;
    }
    return null;
  }

  /**
   * Does the hybrid.admission rule let this key register. Without a hybrid
   * section registration is open. A section whose admission is neither
   * "open" nor an allowlist admits nobody (fail closed). Allowlist entries
   * may be the public key or its keyhash.
   *
   * @static
   * @param {*} hybrid The `hybrid` config section
   * @param {string} publicKey
   * @returns {boolean}
   */
  public static admits(hybrid: any, publicKey: string): boolean {
    if (!HybridConfig.isSection(hybrid)) return true;
    const admission = hybrid.admission;
    if (admission === "open") return true;
    if (admission && Array.isArray(admission.allowlist)) {
      const hash = ActiveCrypto.keyHash(publicKey);
      return admission.allowlist.some(
        (key: unknown) => key === publicKey || key === hash
      );
    }
    return false;
  }

  /**
   * Hostname, IPv4 or bare IPv6 address
   *
   * @private
   * @static
   * @param {*} host
   * @returns {boolean}
   */
  private static validHost(host: any): boolean {
    if (typeof host !== "string" || !host.length || host.length > 253) {
      return false;
    }
    // Bare IPv6
    if (host.indexOf(":") !== -1) {
      return /^[0-9A-Fa-f:.]{2,45}$/.test(host);
    }
    // Hostname or IPv4
    return host
      .split(".")
      .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  }

  /**
   * Make sure an input only carries the properties an entry expects
   *
   * @private
   * @static
   * @param {*} input
   * @param {string[]} allowed
   * @returns {boolean}
   */
  private static onlyKeys(input: any, allowed: string[]): boolean {
    return (
      !!input &&
      typeof input === "object" &&
      Object.keys(input).every((key) => allowed.indexOf(key) !== -1)
    );
  }

  //#endregion

  //#region Smart Contract Entry Points

  /**
   * Check the shape of the transaction before any ledger access
   *
   * @param {boolean} selfsigned
   * @returns {Promise<boolean>}
   */
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (ActiveOptions.get<number>("build", 0) < Hybrid.BUILD) {
        return reject("Hybrid registry not enabled");
      }

      // Exactly one input, the hybrid
      if (Object.keys(this.transactions.$i || {}).length !== 1) {
        return reject("Expecting one input");
      }
      const input = this.input();

      switch (this.transactions.$entry) {
        case "register": {
          if (!selfsigned) return reject("Must be self signed");
          if (
            !Hybrid.onlyKeys(input, ["type", "publicKey", "endpoints", "label"])
          ) {
            return reject("Unknown register fields");
          }
          const invalid =
            Hybrid.validateKey(input.type, input.publicKey) ||
            Hybrid.validateEndpoints(input.endpoints) ||
            Hybrid.validateLabel(input.label);
          return invalid ? reject(invalid) : resolve(true);
        }
        case "update": {
          if (selfsigned) return reject("Must be signed by the hybrid");
          if (!Hybrid.onlyKeys(input, ["endpoints", "$stream"])) {
            return reject("Unknown update fields");
          }
          const invalid = Hybrid.validateEndpoints(input.endpoints);
          return invalid ? reject(invalid) : resolve(true);
        }
        case "retire":
          if (selfsigned) return reject("Must be signed by the hybrid");
          if (!Hybrid.onlyKeys(input, ["$stream"])) {
            return reject("Unknown retire fields");
          }
          return resolve(true);
        default:
          return reject("unknown entry");
      }
    });
  }

  /**
   * Admission for register, a live registration for update and retire
   *
   * @returns {Promise<boolean>}
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (this.transactions.$entry === "register") {
        // On-ledger hybrid.admission (merged into config from the setup stream)
        if (
          !Hybrid.admits(
            ActiveOptions.get<any>("hybrid", null),
            this.input().publicKey
          )
        ) {
          return reject("Hybrid not admitted");
        }
        // Already registered is caught as a stream collision on commit
        return resolve(true);
      }

      // Update and retire: the signature was checked against this stream's
      // authority, which register set to the hybrid's key
      const registration = this.registration();
      if (!registration) return reject("Not a hybrid registration");
      if (registration.getState().retired) return reject("Hybrid retired");
      resolve(true);
    });
  }

  /**
   * Write the registration
   *
   * @returns {Promise<any>}
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const input = this.input();

      switch (this.transactions.$entry) {
        case "register": {
          // Seeded by the keyhash, so the id derives from the key alone
          const activity = this.newActivityStream(
            ActiveCrypto.hybridStreamName(input.publicKey),
            ActiveCrypto.keyHash(input.publicKey)
          );
          activity.setAuthority(input.publicKey, input.type);

          // Only this contract may change it
          activity.setContractLock(this.transactions.$contract);
          activity.setNamespaceLock(this.transactions.$namespace);

          const state = activity.getState();
          state.name = activity.getName();
          state.type = Hybrid.TYPE;
          state.key = input.publicKey;
          state.keyType = input.type;
          state.endpoints = Hybrid.cleanEndpoints(input.endpoints);
          if (input.label !== undefined) state.label = input.label;
          activity.setState(state);
          break;
        }
        case "update": {
          const activity = this.registration() as Activity;
          const state = activity.getState();
          state.endpoints = Hybrid.cleanEndpoints(input.endpoints);
          activity.setState(state);
          break;
        }
        case "retire": {
          const activity = this.registration() as Activity;
          const state = activity.getState();
          state.retired = true;
          activity.setState(state);
          break;
        }
      }
      resolve(true);
    });
  }

  //#endregion

  //#region Helper functions

  /**
   * The single input (verify makes sure there is exactly one)
   *
   * @private
   * @returns {*}
   */
  private input(): any {
    const ref = Object.keys(this.transactions.$i)[0];
    return this.transactions.$i[ref] || {};
  }

  /**
   * The registry stream being updated or retired, or undefined when the
   * input is not one. Must be the stream derived from its own stored key.
   *
   * @private
   * @returns {(Activity | undefined)}
   */
  private registration(): Activity | undefined {
    const ref = Object.keys(this.transactions.$i)[0];
    const id = this.input().$stream || ref;
    const activity = this.getActivityStreams()[id];
    if (!activity) return;
    const state = activity.getState();
    if (
      state.type !== Hybrid.TYPE ||
      typeof state.key !== "string" ||
      ActiveCrypto.hybridStreamId(state.key) !== activity.getId()
    ) {
      return;
    }
    return activity;
  }

  /**
   * Copy just the validated endpoint properties, in a fixed order
   *
   * @private
   * @static
   * @param {any[]} endpoints
   * @returns {any[]}
   */
  private static cleanEndpoints(endpoints: any[]): any[] {
    return endpoints.map((endpoint) => ({
      transport: endpoint.transport,
      host: endpoint.host,
      port: endpoint.port,
    }));
  }

  //#endregion
}
