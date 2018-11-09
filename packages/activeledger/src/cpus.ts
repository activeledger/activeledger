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
   * Attempts to returns the total physical cpus
   *
   * @static
   * @returns {number}
   * @memberof PhysicalCores
   */
  public static count(): number {
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
        return output
          .split(os.EOL)
          .map(function parse(line: string) {
            return parseInt(line);
          })
          .filter(function numbers(value: number) {
            return !isNaN(value);
          })
          .reduce(function add(sum: number, number: number) {
            return sum + number;
          }, 0);
      default:
        // Return logicial cpu and attempt to filter out HT intels.
        return os.cpus().filter(function(cpu, index) {
          const hasHyperthreading = cpu.model.includes("Intel");
          const isOdd = index % 2 === 1;
          return !hasHyperthreading || isOdd;
        }).length;
    }
  }
}
