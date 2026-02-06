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
import * as child from "child_process";
import * as os from "os";


/**
 * Physical processor management
 * Adapted from https://www.npmjs.com/package/physical-cpu-count
 *
 * @export
 * @class PhysicalCores
 */
export class PhysicalCores {
  /**
   * Cache for the physical core count.
   *
   * @private
   * @static
   * @type {(number | null)}
   */
  private static coreCount: number | null = null;
    
  /**
   * Attempts to returns the total physical cpus
   *
   * @static
   * @returns {number}
   */
  public static count(): number {
    // Return from cache if already calculated
    if (this.coreCount !== null) {
      return this.coreCount;
    }

    switch (os.platform()) {
      case "linux":
        return parseInt(
          child.execSync(
            'lscpu -p | egrep -v "^#" | sort -u -t, -k 2,4 | wc -l',
            { encoding: "utf8" }
          )
        );
      case "darwin":
        return parseInt(
          child.execSync("sysctl -n hw.physicalcpu_max", { encoding: "utf8" })
        );
      case "win32":
        const output = child.execSync("WMIC CPU Get NumberOfCores", {
          encoding: "utf8"
        });
        this.coreCount = output
          .split(os.EOL)
          .map(line => parseInt(line, 10))
          .filter(value => !isNaN(value))
          .reduce((sum, number) => sum + number, 0);
        return this.coreCount;
      default:
        const cpus = os.cpus();
        // If core_id is available (modern Node on Linux), use it for a more reliable count.
        // The 'any' cast is for older Node versions where this property might not be typed.
        if (cpus && cpus.length > 0 && (cpus[0] as any).core_id !== undefined) {
          const coreIds = new Set();
          for (const cpu of cpus) {
            coreIds.add((cpu as any).core_id);
          }
          this.coreCount = coreIds.size;
          return this.coreCount;
        } else {
          // Fallback to original logic for other OSes or older Node versions.
          // This attempts to filter out hyper-threaded cores on Intel CPUs.
          this.coreCount = cpus.filter(function(cpu, index) {
            const hasHyperthreading = cpu.model.includes("Intel");
            const isOdd = index % 2 === 1;
            return !hasHyperthreading || isOdd;
          }).length;
          return this.coreCount;
        }
    }
  }
}
