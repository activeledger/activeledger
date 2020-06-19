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
import { ActiveLogger } from "@activeledger/activelogger";

export class PIDHandler {
  private pidFileExists = false;
  private path = ".PID";

  public async init(): Promise<void> {
    await this.pidCheck();
  }

  /**
   * Get all PIDs
   *
   * @returns {Promise<IPID>}
   * @memberof PIDHandler
   */
  public async getPids(): Promise<IPID> {
    const { pidData, error } = await this.readPid();

    if (pidData) {
      return pidData;
    } else if (error) {
      throw error;
    } else {
      throw new Error("Error getting PIDs");
    }
  }

  /**
   * Get a PID
   *
   * @param {EPIDChild} child
   * @returns {Promise<number>}
   * @memberof PIDHandler
   */
  public async getPID(child: EPIDChild): Promise<number> {
    const { pidData, error } = await this.readPid();

    if (error) {
      throw error;
    }

    switch (child) {
      case EPIDChild.CORE:
        if (pidData?.activecore && pidData.activecore !== 0) {
          return pidData.activecore;
        } else {
          throw new Error("Error finding Activecode PID");
        }

      case EPIDChild.RESTORE:
        if (pidData?.activerestore && pidData.activerestore !== 0) {
          return pidData.activerestore;
        } else {
          throw new Error("Error finding Activerestore PID");
        }

      case EPIDChild.LEDGER:
        if (pidData?.activeledger && pidData.activeledger !== 0) {
          return pidData.activeledger;
        } else {
          throw new Error("Error finding Activeledger PID");
        }

      case EPIDChild.STORAGE:
        if (pidData?.activestorage && pidData.activestorage !== 0) {
          return pidData.activestorage;
        } else {
          throw new Error("Error finding Activestorage PID");
        }

      default:
        throw new Error("Unkown PID requested");
    }
  }

  public async getStatus(): Promise<boolean> {
    try {
      const ledgerPID = await this.getPID(EPIDChild.LEDGER);
      process.kill(ledgerPID, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Add a PID to the file
   *
   * @param {EPIDChild} child
   * @param {number} pid
   * @returns {Promise<void>}
   * @memberof PIDHandler
   */
  public async addPid(child: EPIDChild, pid: number): Promise<void> {
    const { pidData, error } = await this.readPid();
    if (error) {
      ActiveLogger.error("Error reading PID file", error);
    }

    try {
      if (pidData) {
        pidData[child] = pid;
      } else {
        ActiveLogger.warn("No PID data");
      }
    } catch (error) {
      ActiveLogger.error(error, "Error adding PID to data");
      return;
    }

    try {
      await this.writePid(pidData);
    } catch (error) {
      ActiveLogger.error(error, `Error writing ${child} PID to file`);
    }
  }

  /**
   * Remove a PID from the file
   *
   * @param {EPIDChild} child
   * @returns {Promise<void>}
   * @memberof PIDHandler
   */
  public async removePid(child: EPIDChild): Promise<void> {
    // Use the add function to reset the pid to 0
    return await this.addPid(child, 0);
  }

  /**
   * Reset the PID file, sets all PIDs to 0
   *
   * @returns {Promise<void>}
   * @memberof PIDHandler
   */
  public async resetPidFile(): Promise<void> {
    return await this.writePid();
  }

  /**
   * Check if the PID file exists
   *
   * @private
   * @returns {Promise<void>}
   * @memberof PIDHandler
   */
  private async pidCheck(): Promise<void> {
    try {
      await fs.access(this.path);
      this.pidFileExists = true;
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        ActiveLogger.error(error, "Error checking for PID file");
      } else {
        ActiveLogger.info("PID file doesn't exist, attempting to create");
        await this.writePid();
      }
    }
  }

  /**
   * Write PID data to file
   *
   * @private
   * @param {IPID} [data]
   * @returns {Promise<void>}
   * @memberof PIDHandler
   */
  private async writePid(data?: IPID): Promise<void> {
    if (!data) {
      data = {
        activeledger: 0,
        activestorage: 0,
        activecore: 0,
        activerestore: 0,
      };
    }

    try {
      await fs.writeFile(this.path, JSON.stringify(data));
    } catch (error) {
      ActiveLogger.error(
        error,
        "Error creating the PID file, 'activeledger --stop' may not function"
      );
    }
  }

  /**
   * Reads the PID file and returns the data
   *
   * @private
   * @returns {Promise<{pidData?: IPID, error?: Error}>}
   * @memberof PIDHandler
   */
  private async readPid(): Promise<{ pidData?: IPID; error?: Error }> {
    if (!this.pidFileExists) {
      ActiveLogger.warn("PID file doesn't exist to read");
    }

    try {
      const data: IPID = JSON.parse((await fs.readFile(this.path)).toString());
      return { pidData: data };
    } catch (error) {
      return { pidData: undefined, error };
    }
  }
}

export enum EPIDChild {
  LEDGER = "activeledger",
  STORAGE = "activestorage",
  CORE = "activecore",
  RESTORE = "activerestore",
}

interface IPID {
  activeledger: number;
  activestorage: number;
  activecore: number;
  activerestore: number;
}
