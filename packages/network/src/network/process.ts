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

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveDSConnect, ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveProtocol } from "@activeledger/activeprotocol";

class Processor {
  //private static right: ActiveDefinitions.INeighbourBase;
  public static db: ActiveDSConnect;
  public static dbe: ActiveDSConnect;
  public static dbev: ActiveDSConnect;
  public static secured: ActiveCrypto.Secured;
  private static neighbourhood: { [reference: string]: Neighbour };
  private static pubKey: string;
  private static prvKey: string;

  public static setup(
    right: any,
    neighbours: { [reference: string]: Neighbour },
    db: any
  ) {
    Processor.neighbourhood = neighbours;

    // Create connection string
    Processor.db = new ActiveDSConnect(db.url + "/" + db.database);

    // Create connection string
    Processor.dbe = new ActiveDSConnect(db.url + "/" + db.error);

    // Create connection string
    Processor.dbev = new ActiveDSConnect(db.url + "/" + db.event);

    Processor.housekeeping(right, neighbours);
    ActiveLogger.info("Processor Setup Complete");
  }

  public static housekeeping(
    right: any,
    neighbours?: { [reference: string]: Neighbour }
  ) {
    Home.right = new Neighbour(right.host, right.port);

    if (neighbours) {
      Processor.neighbourhood = neighbours;

      Processor.secured = new ActiveCrypto.Secured(
        Processor.db,
        Processor.neighbourhood,
        {
          reference: Home.reference,
          public: Home.publicPem,
          private: Home.identity.pem
        }
      );
    }
  }
}

// Initalise CLI Options
ActiveOptions.init();

// Now we can parse configuration
ActiveOptions.parseConfig();

// Enable Extended Debugging
ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

// Listen for IPC (Interprocess Communication)
process.on("message", (m: any) => {
  switch (m.type) {
    case "setup":
      // Set Database (Do we need to?)
      ActiveOptions.set("db", m.data.db);

      //? How oftern do we access Options do we need to sync again?
      ActiveOptions.set("__base", m.data.__base);

      ActiveOptions.extendConfig()
        .then(() => {
          // Setup Static Home
          Home.reference = m.data.reference;
          Home.host = m.data.self;
          Home.publicPem = m.data.public;
          Home.identity = new ActiveCrypto.KeyPair("rsa", m.data.private);

          // Setup Static Processor
          Processor.setup(m.data.right, m.data.neighbourhood, m.data.db);
        })
        .catch(e => {
          ActiveLogger.fatal(e, "Config Extension Issues");
        });
      break;
    case "hk":
      ActiveLogger.debug("House Keeping!");
      Processor.housekeeping(m.data.right, m.data.neighbourhood);
      break;
    case "tx":
      //! Manage unhandledRejections

      // Create new Protocol Process object for transaction
      let protocol: ActiveProtocol.Process = new ActiveProtocol.Process(
        m.entry,
        Home.host,
        Home.reference,
        Home.right,
        Processor.db,
        Processor.dbe,
        Processor.dbev,
        Processor.secured
      );

      protocol.on("commited", (response: any) => {
        // Pass back to host to respond.
        (process as any).send({
          type: "commited",
          data: m.entry
        });
      });

      protocol.on("failed", (error: any) => {
        // Pass back to host to respond
        (process as any).send({
          type: "failed",
          data: m.entry
        });
      });

      protocol.on("broadcast", (response: any) => {
        // TODO: Either broadcast from this prcoessor.
        // TODO: although from there is better as it can respond quicker
        // Pass back to host to respond
        (process as any).send({
          type: "broadcast",
          data: m.entry
        });
      });

      protocol.on("reload", (response: any) => {
        // Pass back to host to respond
        (process as any).send({
          type: "reload"
        });
      });

      // Start the process
      protocol.start();
      break;
    case "destory":
      // Remove protocol from memory. 
      break
    default:
      ActiveLogger.fatal(m, "Unknown Processor Call");
  }
});
