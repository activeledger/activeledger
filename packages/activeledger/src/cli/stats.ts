import { promises as fs } from "fs";
import * as os from "os";
import { ActiveLogger } from "@activeledger/activelogger";
import { PIDHandler } from "./pid";

export class StatsHandler {
  private statsFileExists = false;
  private path = ".STATS";
  private pidHandler: PIDHandler;

  constructor() {
    this.pidHandler = new PIDHandler();
  }

  public async init(): Promise<void> {
    await this.pidHandler.init();
    await this.statsCheck();
  }

  public async getStats(): Promise<IStats> {
    const { data, error } = await this.readFileStats();
    if (error) {
      // TODO
    }

    const statsFileData: IStatsFile = data as IStatsFile;

    const stats: IStats = {
      cpu: this.getCPU(),
      ram: this.getRAM(),
      hdd: 1,
      io: 1,
      status: await this.pidHandler.getStatus() ? "alive" : "dead",
      restarts: statsFileData.restarts,
      uptime: Date.now() - statsFileData.startTime
    };

    return stats;
  }

  public async resetUptime(): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(error, "Error reseting uptime, data may be inaccurate.");
      return;
    }

    if (data) {
      data.startTime = 0;
      await this.writeStats(data);
    }

    return;

  }

  public async updateRestartCount(auto?: boolean): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(error, "Error updating restart count, data may be inaccurate.");
      return;
    }

    if (data) {
      if (auto) {
        data.restarts.auto++;
        data.restarts.lastAuto = new Date();
      } else {
        await this.resetAutoRestartCount();
        data.restarts.lastManual = new Date();
      }
      data.restarts.all++;
      await this.writeStats(data);
    }

    return;

  }

  public async resetAutoRestartCount(): Promise<void> {
    const { data, error } = await this.readFileStats();

    if (error) {
      ActiveLogger.warn(error, "Error updating restart count, data may be inaccurate.");
      return;
    }

    if (data) {
      data.restarts.auto = 0;
      data.restarts.lastAuto = undefined;
      await this.writeStats(data);
    }

    return;
  }

  private getCPU(): ICPUStats {

    const average = os.loadavg();

    return {
      one: average[0],
      five: average[1],
      fifteen: average[2],
    }
  }

  private getRAM(): number {
    return os.totalmem() - os.freemem();
  }

  private async getHDD(): Promise<number> {
    if (os.type() !== "Windows_NT") {
      return 1;
    } else {
      return 0;
    }
  }

  private async getIO(): Promise<number> {
    if (os.type() !== "Windows_NT") {
      return 1;
    } else {
      return 0;
    }
  }

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

  private async writeStats(data?: IStatsFile): Promise<void> {
    if (!data) {
      data = {
        restarts: {
          all: 0,
          auto: 0,
          lastManual: undefined,
          lastAuto: undefined,
        },
        startTime: Date.now()
      };
    }

    try {
      await fs.writeFile(this.path, JSON.stringify(data));
    } catch (error) {
      ActiveLogger.error(
        error,
        "Error creating the Stats file, 'activeledger --stats' may not function correctly"
      );
    }
  }

  private async readFileStats(): Promise<{ data?: IStatsFile; error?: Error }> {
    if (!this.statsFileExists) {
      ActiveLogger.warn("Stats file doesn't exist to read");
    }

    try {
      const data: IStatsFile = JSON.parse((await fs.readFile(this.path)).toString());
      return { data };
    } catch (error) {
      return { data: undefined, error };
    }
  }
}

interface ICPUStats {
  one: number;
  five: number;
  fifteen: number;
}

interface IStats {
  cpu: ICPUStats;
  ram: number;
  hdd: number;
  io: number;
  status: "alive" | "dead";
  restarts: IRestartStats;
  uptime: number;
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