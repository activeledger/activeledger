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

import { promises as fs } from "fs";
import * as os from "os";
import { ActiveLogger } from "@activeledger/activelogger";
import { PIDHandler } from "./pid";
import { execSync } from "child_process";

/**
 * Stats handling
 *
 * @export
 * @class StatsHandler
 */
export class StatsHandler {
  private statsFileExists = false;
  private path = ".STATS";
  private pidHandler: PIDHandler;
  private version: string = "unset";

  constructor() {
    this.pidHandler = new PIDHandler();
  }

  /**
   * Initialise the stats handler
   *
   * Initialises the PID handler for restart counting
   * Checks the stats file exists
   *
   * @returns {Promise<void>}
   */
  public async init(version?: string): Promise<void> {
    if (version) {
      this.version = version;
    }
    await this.pidHandler.init();
    await this.statsCheck();
  }

  /**
   * Returns a stats object
   *
   * Note: Windows implementation of disk usage not currently implemented, this will return 0s
   *
   * @returns {Promise<IStats>}
   */
  public async getStats(): Promise<IStats> {
    const { data, error } = await this.readFileStats();
    if (error) {
      throw error;
    } else {
      const statsFileData: IStatsFile = data as IStatsFile;
      const status = (await this.pidHandler.getStatus()) ? "alive" : "dead";
      const uptime =
        status === "alive" ? Date.now() - statsFileData.startTime : 0;

      const stats: IStats = {
        cpu: this.getCPU(),
        ram: this.getRAM(),
        hdd: await this.getHDD(),
        status,
        restarts: statsFileData.restarts,
        uptime,
        version: this.version,
      };

      return stats;
    }
  }

  /**
   * Reset the uptime counter
   *
   * @returns {Promise<void>}
   */
  public async resetUptime(): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(
        error,
        "Error reseting uptime, data may be inaccurate."
      );
      return;
    }

    if (data) {
      data.startTime = Date.now();
      await this.writeStats(data);
    }

    return;
  }

  /**
   * Update the restart counter
   *
   * Resets the auto counter on a manual restart
   *
   * @param {boolean} [auto]
   * @returns {Promise<void>}
   */
  public async updateRestartCount(auto?: boolean): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(
        error,
        "Error updating restart count, data may be inaccurate."
      );
      return;
    }

    if (data) {
      if (auto) {
        data.restarts.auto += 1;
        data.restarts.lastAuto = new Date();
      } else {
        data.restarts.auto = 0;
        data.restarts.lastAuto = undefined;
        data.restarts.lastManual = new Date();
      }
      data.restarts.all++;
      try {
        await this.writeStats(data);
      } catch (error) {
        ActiveLogger.error("Error writing restart stats");
        ActiveLogger.error(error);
      }
    }

    return;
  }

  /**
   * Reset the auto restart count
   *
   * @returns {Promise<void>}
   */
  public async resetAutoRestartCount(): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(
        error,
        "Error updating restart count, data may be inaccurate."
      );
      return;
    }

    if (data) {
      data.restarts.auto = 0;
      data.restarts.lastAuto = undefined;
      await this.writeStats(data);
    }

    return;
  }

  /**
   * Get the average CPU load
   *
   * @private
   * @returns {ICPUStats}
   */
  private getCPU(): ICPUStats {
    const average = os.loadavg();

    return {
      cores: os.cpus().length,
      one: average[0],
      five: average[1],
      fifteen: average[2],
    };
  }

  /**
   * Get the total and free memory
   *
   * @private
   * @returns {IRAMStats}
   */
  private getRAM(): IRAMStats {
    return {
      total: os.totalmem(),
      free: os.freemem(),
    };
  }

  /**
   * Get disk stats
   *
   * Returns:
   * * Activeledger instance size
   * * Total disk space
   * * Free disk space
   * * Used disk space
   *
   * @private
   * @returns {Promise<IDiskStats>}
   */
  private getHDD(): IDiskStats {
    try {
      if (os.type() !== "Windows_NT") {
        const activeledgerUsage = execSync(`du . -s`).toString().split("\t")[0];
        const diskUsageArray = execSync(`df / --output=size,avail,used`)
          .toString()
          .split("\n")[1]
          .split(" ");

        const diskStats: IDiskStats = {
          activeledger: parseInt(activeledgerUsage),
          diskSize: parseInt(diskUsageArray[0]),
          diskFree: parseInt(diskUsageArray[1]),
          diskUsed: parseInt(diskUsageArray[2]),
        };

        return diskStats;
      } else {
        return {
          activeledger: 0,
          diskSize: 0,
          diskFree: 0,
          diskUsed: 0,
        };
      }
    } catch (error) {
      ActiveLogger.error(error, "Error reading disk stats, returning 0s");
      return {
        activeledger: 0,
        diskSize: 0,
        diskFree: 0,
        diskUsed: 0,
      };
    }
  }

  /**
   * Possible future extension
   *
   * @private
   * @returns {Promise<number>}
   */
  private async getIO(): Promise<number> {
    if (os.type() !== "Windows_NT") {
      return 1;
    } else {
      return 0;
    }
  }

  /**
   * Check for the stats file
   *
   * @private
   * @returns {Promise<void>}
   */
  private async statsCheck(): Promise<void> {
    try {
      await fs.access(this.path);
      this.statsFileExists = true;
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        ActiveLogger.error(error, "Error checking for Stats file");
      } else {
        ActiveLogger.info("Stats file doesn't exist, attempting to create");
        await this.writeStats();
      }
    }
  }

  /**
   * Write stats to disk
   *
   * Writes restart information and startTime to stats file
   *
   * @private
   * @param {IStatsFile} [data]
   * @returns {Promise<void>}
   */
  private async writeStats(data?: IStatsFile): Promise<void> {
    if (!data) {
      data = {
        restarts: {
          all: 0,
          auto: 0,
          lastManual: undefined,
          lastAuto: undefined,
        },
        startTime: Date.now(),
      };
    }

    try {
      await fs.writeFile(this.path, JSON.stringify(data));
    } catch (error) {
      ActiveLogger.error(
        error,
        "Error writing the Stats file, 'activeledger --stats' may not function correctly"
      );
    }
  }

  /**
   * Read the stats file
   *
   * @private
   * @returns {Promise<{ data?: IStatsFile; error?: Error }>}
   */
  private async readFileStats(): Promise<{ data?: IStatsFile; error?: Error }> {
    if (!this.statsFileExists) {
      ActiveLogger.warn("Stats file doesn't exist to read");
    }

    try {
      const data: IStatsFile = JSON.parse(
        (await fs.readFile(this.path)).toString()
      );
      return { data };
    } catch (error) {
      return { data: undefined, error };
    }
  }
}

interface ICPUStats {
  cores: number;
  one: number;
  five: number;
  fifteen: number;
}

interface IStats {
  cpu: ICPUStats;
  ram: IRAMStats;
  hdd: IDiskStats;
  // IO might be added in future
  // io: number;
  status: "alive" | "dead";
  restarts: IRestartStats;
  uptime: number;
  version: string;
}

interface IRestartStats {
  all: number;
  auto: number;
  lastManual: Date | undefined;
  lastAuto: Date | undefined;
}

interface IStatsFile {
  restarts: IRestartStats;
  startTime: number;
}

interface IDiskStats {
  activeledger: number;
  diskSize: number;
  diskFree: number;
  diskUsed: number;
}

interface IRAMStats {
  total: number;
  free: number;
}
