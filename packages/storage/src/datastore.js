import * as fs from "fs";
import { promises as fsPromises } from "fs";
import * as child from "child_process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
const MAX_RESTARTS = 5;
const MAX_RESTART_RESET_HOURS = 24;
export class ActiveDataStore {
    isShuttingDown = false;
    dsLocation;
    process;
    restartCounter = 0;
    lastRestart = Date.now();
    constructor() {
        this.dsLocation = ActiveOptions.get("db", {}).selfhost.dir || "./.ds";
        if (!fs.existsSync(this.dsLocation)) {
            fs.mkdirSync(this.dsLocation);
        }
        ActiveLogger.info("Self-hosted data engine @ http://127.0.0.1:" +
            ActiveOptions.get("db", {}).selfhost.port);
    }
    launch() {
        const dbInfo = ActiveOptions.get("db", {});
        this.process = child.spawn("node", [
            __dirname + "/selfhost.js",
            this.dsLocation,
            `${dbInfo.selfhost.port}`,
            `${dbInfo.selfhost.engine || "level"}`,
            `${dbInfo.selfhost.host || "127.0.0.1"}`,
            ...(dbInfo.selfhost.cache === true
                ? [`${dbInfo.database || "activeledger"}`]
                : []),
        ], {
            stdio: "inherit",
            env: {
                ...process.env,
                ...(dbInfo.selfhost.writeBufferMb > 0
                    ? { ACTIVE_LEVEL_WRITE_BUFFER_MB: `${dbInfo.selfhost.writeBufferMb}` }
                    : {}),
                ...(dbInfo.selfhost.cacheMb > 0
                    ? { ACTIVE_LEVEL_CACHE_MB: `${dbInfo.selfhost.cacheMb}` }
                    : {}),
            },
        });
        ActiveLogger.info(`Self-hosted data engine (${dbInfo.selfhost.engine || "level"})  : Starting Up (${this.process.pid})`);
        this.storePid(this.process.pid || 0);
        this.process.on("exit", (code, signal) => {
            ActiveLogger.error(`Self-hosted data engine has shutdown (${code} : ${signal || "No Signal"})`);
            if (Date.now() >
                this.lastRestart + MAX_RESTART_RESET_HOURS * 60 * 60 * 1000) {
                this.restartCounter = 0;
            }
            if (!this.isShuttingDown &&
                signal !== "SIGTERM" &&
                MAX_RESTARTS > this.restartCounter) {
                this.restartCounter++;
                this.lastRestart = Date.now();
                this.launch();
            }
            else {
                ActiveLogger.error("Not attempting to restart either due to signal or counters reached");
            }
        });
        return "http://127.0.0.1:" + ActiveOptions.get("db", {}).selfhost.port;
    }
    async storePid(pid) {
        const pidPath = ".PID";
        let pidData;
        try {
            pidData = JSON.parse((await fsPromises.readFile(pidPath)).toString());
            pidData.activestorage = pid;
            await fsPromises.writeFile(pidPath, JSON.stringify(pidData));
        }
        catch (error) {
            ActiveLogger.warn("Error storing PID, activeledger --stop may not work correctly");
            ActiveLogger.warn(error.message);
        }
    }
}
//# sourceMappingURL=datastore.js.map