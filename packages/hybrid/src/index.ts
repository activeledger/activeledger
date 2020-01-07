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

            http.use("/", "POST", async (incoming: IActiveHttpIncoming, r: any) => {
                const tx = incoming.body as ActiveDefinitions.LedgerEntry;
                console.log(tx);
                // Check Token And "From Server"

                // Endpoints ExternalInit validation needed

                // What to do with locking, Same principle? Or self manage
                // we should self manage here because mainnet wont really submit
                // unless we get into handling that on the mainnet side. Then we could get stuck in
                // forever loops!

                // Run Transaction

                // Worked or failed we should still resend to nodes connected to us!

                // NOT FOR NOW : With IoT and core no auth, I wonder if the solution
                // is they sign a code with their key to get the SSE connection accepted?
                // doing this means we could also send in real-time from a mainnet node
                // However for now best to keep in here less overhead and less chance of vunrabilities

                // If everything is ok, return ok

                // If failed report as error to database and remote

                // Remote may then send the "latest version"

                // As we will be single threaded for the moment it shouldnt be an issue for fast transactions.
                // However we may need to do some rev matching.

                // Remote Side if ok then skip
                // Remote side if not 200 status code store for later push

                // Should we push to other hybrids of the hybrids?

                // Trick Process
                tx.$nodes = {
                    hybrid: {
                        vote: false,
                        commit: false
                    }
                };

                //tx.$broadcast = true;

                // Create new Protocol Process object for transaction
                let protocol = new ActiveProtocol.Process(
                    tx,
                    "hybrid", // Maybe Mimic
                    "hybrid", // Maybe Mimic
                    { knock: () => { console.log("KNOCKED ME"); return {} } } as any,
                    dbConnection,
                    dbErrorConnection,
                    dbEventConnection,
                    new ActiveCrypto.Secured(db, {}, {}) // Fix this
                );

                // Listen to global unhandled!

                // Listen for unhandledRejects (Most likely thrown by Contract but its a global)
                // While it is global we need to manage it here to keep the encapsulation
                // this.unhandledRejection[m.entry.$umid] = (reason: Error) => {
                //     // Make sure the object exists
                //     if (this.protocols[m.entry.$umid]) {
                //         this.unhandled(m.entry, reason);
                //     }
                // };


                // Event: Manage Unhandled Rejections from VM
                // process.on(
                //     "unhandledRejection",
                //     this.unhandledRejection[m.entry.$umid]
                // );

                // Event: Manage Commits
                protocol.on("commited", (response: any) => {
                    console.log("I DID IT!!");
                    return { status: "ok" };

                });

                // Event: Manage Failed
                protocol.on("failed", (error: any) => {
                    ActiveLogger.error(error, "I failed because :");

                    return { status: "ok" };
                    // this.failed(m.entry, error.error);
                });

                // Event: Manage broadcast
                protocol.on("broadcast", () => {
                    console.log("I SHOULD NOT BE HERE!!");
                    console.log("Actually this is how we can trick consensus");
                    return { status: "ok" };

                });

                // Event: Manage Reload Requests
                protocol.on("reload", () => {
                    console.log("I should do nothing IT!!");
                    return { status: "ok" };

                });

                // Event: Manage Throw Transactions
                protocol.on("throw", (response: any) => {
                    console.log("Should I throw maybe NOT");
                    return { status: "ok" };

                });

                // MAY NEED TO MODIFY COSNESUS
                // Start the process
                protocol.start();



                // return { status: "ok" };

            })


            // Testing Purposes
            http.use("/", "GET", async () => {
                console.log("how manay times");
                return { hello: "world" }
            })

            // Listen!
            const [, port] = ActiveOptions.get<String>("host", ":5260").split(":");
            http.listen(parseInt(port), true);
            ActiveLogger.info("Activecore Hybrid is running at 0.0.0.0:" + port);
        })
        .catch((e) => {
            throw new Error("Couldn't create default index");
        });

}