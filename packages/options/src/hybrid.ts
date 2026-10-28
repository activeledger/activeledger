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

/** Strict semver, as npm publishes it (no leading zeros, no "v" prefix) */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A stream id: sha256 hex */
const STREAM_ID = /^[a-f0-9]{64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.indexOf(key) !== -1);

/**
 * The `hybrid` section of the network config. It is asserted on-ledger into
 * the setup stream beside `security` and `consensus`, so every supernode
 * enforces and serves the same rules:
 *
 * {
 *   admission: "open" | { allowlist: [publicKey | keyHash] },
 *   required: [streamId | { id: streamId }],
 *   window: { days: number },
 *   minVersion: "5.1.0"
 * }
 */
export class HybridConfig {
  /**
   * Is this a `hybrid` section, rather than nothing or the legacy
   * `config.hybrid[]` URL list (removed in v5.1; an array is ignored, never
   * asserted)
   */
  public static isSection(value: unknown): boolean {
    return isObject(value);
  }

  /**
   * Validate a `hybrid` section. Returns the reason it is invalid, or null.
   * Unknown properties are refused so a typo cannot silently become the
   * network's rule.
   */
  public static validate(value: unknown): string | null {
    if (!isObject(value)) return "hybrid must be an object";
    if (!onlyKeys(value, ["admission", "required", "window", "minVersion"])) {
      return "hybrid has unknown properties";
    }

    // Admission
    const admission = value.admission;
    if (admission !== "open") {
      if (
        !isObject(admission) ||
        !onlyKeys(admission, ["allowlist"]) ||
        !Array.isArray(admission.allowlist) ||
        !admission.allowlist.every(
          (key: unknown) => typeof key === "string" && key.length > 0
        )
      ) {
        return 'hybrid.admission must be "open" or {allowlist:[keys]}';
      }
    }

    // Required streams
    if (!Array.isArray(value.required)) {
      return "hybrid.required must be an array";
    }
    for (const entry of value.required) {
      const valid =
        typeof entry === "string"
          ? STREAM_ID.test(entry)
          : isObject(entry) &&
            onlyKeys(entry, ["id", "volatile"]) &&
            typeof entry.id === "string" &&
            STREAM_ID.test(entry.id) &&
            // 5.1.0 wrote a boolean here. It is ignored now, but a network
            // asserted with it must still validate.
            (entry.volatile === undefined ||
              typeof entry.volatile === "boolean");
      if (!valid) {
        return "hybrid.required entries must be a stream id or {id}";
      }
    }

    // Storage window
    const window = value.window;
    if (
      !isObject(window) ||
      !onlyKeys(window, ["days"]) ||
      !Number.isInteger(window.days) ||
      (window.days as number) < 1
    ) {
      return "hybrid.window must be {days} with a whole number of days";
    }

    // Oldest hybrid release allowed to follow this network
    if (
      typeof value.minVersion !== "string" ||
      !SEMVER.test(value.minVersion)
    ) {
      return "hybrid.minVersion must be a semver version";
    }

    return null;
  }
}
