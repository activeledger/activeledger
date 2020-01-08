#!/usr/bin/env node

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
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveHttpd, IActiveHttpIncoming } from "@activeledger/httpd";
import { ActiveDataStore } from "@activeledger/activestorage";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { IncomingMessage } from "http";

// WARNING: Lots of copy pasted code here in functional way, Get working then improve!

// Initalise CLI Options
ActiveOptions.init();

//#region Check & Manage Configuration File
if (!fs.existsSync(ActiveOptions.get<string>("config", "./config.json"))) {
    // Read default config so we can add our identity to the neighbourhood
    let defConfig: any = JSON.parse(
        fs.readFileSync(__dirname + "/default.config.json", "utf8")
    );

    // Adjusting Ports (Check for default port)
    if (
        ActiveOptions.get<boolean>("port", false) &&
        ActiveOptions.get<number>("port", 5260) !== 5260
    ) {
        // Update Node Host
        defConfig.host =
            ActiveOptions.get<string>("host", "127.0.0.1") +
            ":" +
            ActiveOptions.get<string>("port", 5260);

        // Update Self host
        defConfig.db.selfhost.port = (
            parseInt(ActiveOptions.get<string>("port", 5260)) - 1
        ).toString();
    }

    // Data directory passed?
    if (ActiveOptions.get<boolean>("data-dir", false)) {
        defConfig.db.selfhost.dir = ActiveOptions.get<string>("data-dir", "");
    }

    // lets write the default one in this location
    fs.writeFileSync(
        ActiveOptions.get<string>("config", "./config.json"),
        JSON.stringify(defConfig)
    );
    ActiveLogger.info(
        "Created Hybrid Config File"
    );
}
//#endregion
ActiveOptions.parseConfig();

// Set Base Path
ActiveOptions.set("__base", __dirname);

// Check for local contracts folder
if (!fs.existsSync("contracts")) fs.mkdirSync("contracts");

// Check for modules link for running contracts
if (!fs.existsSync("contracts/node_modules"))
    fs.symlinkSync(
        `${__dirname}/../node_modules`,
        "contracts/node_modules",
        "dir"
    );

// Get Default Db connection data
const db = ActiveOptions.get<any>("db", false);

// Basic check for database and config
if (ActiveOptions.get("db", false)) {

    // Self Hosted Database
    if (ActiveOptions.get<any>("db", {}).selfhost) {
        // Create Datastore instance
        let datastore: ActiveDataStore = new ActiveDataStore();

        // Rewrite config for this process
        ActiveOptions.get<any>("db", {}).url = datastore.launch();

        // Enable Extended Debugging
        ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

        // Wait a bit for process to fully start
        setTimeout(() => {
            boot();
        }, 2000);

    }
} else {
    ActiveLogger.fatal("Configuration file incomplete");
    process.exit(0);
}


/**
 * Start Hybrid Application
 *
 */
function boot() {

    // Create connection string
    const dbConnection = new ActiveDSConnect(db.url + "/" + db.database);
    dbConnection.info();

    // Create connection string
    const dbErrorConnection = new ActiveDSConnect(db.url + "/" + db.error);
    dbErrorConnection.info();

    // Create connection string
    const dbEventConnection = new ActiveDSConnect(db.url + "/" + db.event);
    dbEventConnection.info();

    // Get Downstream Attached Hybrid Hosts
    // Enable in the future
    //const attachedHybridHosts = ActiveOptions.get<ActiveDefinitions.IHybridNodes[]>("hybrid", []);

    // Create Index
    dbConnection
        .createIndex({
            index: {
                fields: ["namespace", "type", "_id"]
            }
        })
        .then(() => {
            // Create Light Server
            let http = new ActiveHttpd(true);

            http.use("/", "POST", async (incoming: IActiveHttpIncoming, req: IncomingMessage) => {
                if (incoming.body && ActiveDefinitions.LedgerTypeChecks.isEntry(incoming.body)) {
                    const tx = incoming.body as ActiveDefinitions.LedgerEntry;
                    // Check Token And "From Server"


                    // What to do with locking, Same principle? Or self manage
                    // we should self manage here because mainnet wont really submit
                    // unless we get into handling that on the mainnet side. Then we could get stuck in
                    // forever loops!


                    // NOT FOR NOW : With IoT and core no auth, I wonder if the solution
                    // is they sign a code with their key to get the SSE connection accepted?
                    // doing this means we could also send in real-time from a mainnet node
                    // However for now best to keep in here less overhead and less chance of vunrabilities



                    // Should we push to other hybrids of the hybrids?


                    // We should ignore ALL default/setup calls we don't know anything but our upstream server

                    // Let Contract know its running inside a hybrid
                    tx.$nodes = {
                        hybrid: {
                            vote: false,
                            commit: false
                        }
                    };

                    // Make sure it isn't a broadcast transaction
                    tx.$broadcast = false;

                    // Create new Protocol Process object for transaction
                    let protocol = new ActiveProtocol.Process(
                        tx,
                        "hybrid",
                        "hybrid",
                        {} as any,
                        dbConnection,
                        dbErrorConnection,
                        dbEventConnection,
                        // Fix this, So we can run all in contract encryption / decryption processes but as developers won't know the hybrid nodes they cant be targetting 
                        new ActiveCrypto.Secured(db, {}, {})
                    );


                    // Simpler UnhandledRejects Processing
                    process.once("unhandledRejection", () => {
                        return { status: "unhandledRejection " };
                    })

                    // Event: Manage Commits
                    protocol.on("commited", (response: any) => {
                        // Send on to IoT
                        return { status: "ok" };
                    });

                    // Event: Manage Failed
                    protocol.on("failed", (error: any) => {
                        ActiveLogger.error(error, "I failed because :");
                        return { status: "failed" };
                    });

                    // Event: Manage broadcast
                    // Hybrid doesn't need to broadcast as it isn't a network its store and forward
                    // protocol.on("broadcast", () => {});

                    // Event: Manage Reload Requests
                    // We won't be adding / removing nodes so no need to reload!
                    // INFO : Possibly we need to create code to ignore those type of transactions?
                    // protocol.on("reload", () => {});

                    // Event: Manage Throw Transactions
                    // Developers won't know about all the hybrid nodes
                    // So we can ignore this event
                    // protocol.on("throw", (response: any) => {});

                    // Start the process
                    protocol.start();
                } else {
                    return;
                }
            })


            // Testing Purposes
            http.use("/", "GET", async (a: IActiveHttpIncoming) => {
                return { hello: "world" }
            })

            // Start Hybrider Listner (Single Threaded Process for now)
            const [, port] = ActiveOptions.get<String>("host", ":5260").split(":");
            http.listen(parseInt(port), true);
            ActiveLogger.info("Activecore Hybrid is running at 0.0.0.0:" + port);
        })
        .catch((e) => {
            throw new Error("Couldn't create default index");
        });

}