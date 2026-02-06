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

//import { Server, IncomingMessage, ServerResponse, createServer } from "http";
import { fork, ChildProcess } from "child_process";
import { readlinkSync } from "fs";
import { basename } from "path";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveGZip,
  ActiveRequest,
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints, Maintain } from "./index";
import { Locker } from "./locker";
import { PhysicalCores } from "./cpus";
import * as process from "process";
import {
  App,
  HttpResponse,
  TemplatedApp,
  us_listen_socket,
  us_listen_socket_close,
} from "uWebSockets.js";

const RELEASE_SHUTDOWN_TIMEOUT = 1 * 60 * 1000;
const RELEASE_DELETE_TIMEOUT = 2 * 60 * 1000;
// const RELEASE_SHUTDOWN_TIMEOUT = 5000;
// const RELEASE_DELETE_TIMEOUT = 2000;
const TIMER_QUEUE_INTERVAL = 2 * 1000;
const GRACEFUL_PROC_SHUTDOWN = 7 * 60 * 1000;
const KILL_PROC_SHUTDOWN = 2.5 * 1000;
const MAX_RETRIES = 35; // Bubbling up error (may need different counters)

/**
 * Process object used to manage an individual transaction
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: any;
  reject: any;
  pid: number;
  finished: boolean;
  responded: boolean;
  shutdown?: boolean;
}

/**
 * Setup object for a processor process
 *
 * @interface setup
 */
interface setup {
  type: string;
  data: {
    self: string;
    reference: string;
    right: Neighbour;
    neighbourhood: {
      [reference: string]: Neighbour;
    };
    pubPem: string;
    privPem: any;
    db: any;
    __base: unknown;
  };
}

/**
 * Extend  ChildProcess and add stoppable flag
 *
 * @interface StoppableChildProcess
 * @extends {ChildProcess}
 */
interface StoppableChildProcess extends ChildProcess {
  stop: boolean;
}

interface BusyLockQueue {
  running: boolean;
  entry: ActiveDefinitions.LedgerEntry;
  retry: number;
}

/**
 * Hosted process for API and Protocol management
 *
 * @export
 * @class Host
 * @extends {Home}
 */
export class Host extends Home {
  /**
   * Holds underlying socket
   *
   * @private
   * @type {us_listen_socket}
   */
  private listenSocket: us_listen_socket | null;

  /**
   * All communications done via a single REST server
   * we will need to manage permissions and security to seperate the calls
   *
   * @type {Server}
   */
  public readonly api: TemplatedApp;

  /**
   * Server connection to the couchdb instance for this node
   *
   * @public
   * @type ActiveDSConnect
   */
  public dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @public
   * @type ActiveDSConnect
   */
  public dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type ActiveDSConnect
   */
  private dbEventConnection: ActiveDSConnect;

  /**
   * Holds the processPending requests before processing
   *
   * @private
   * @type {*}
   */
  private processPending: {
    [reference: string]: process;
  } = {};

  /**
   * How many cpu processors have said they're ready
   *
   * @private
   */
  private cpuReady = 0;

  /**
   * How many hybrid connected nodes
   *
   * @private
   */
  private hybridHosts: ActiveDefinitions.IHybridNodes[];

  /**
   * Holds transactions to be run as locks released.
   * Basic formation of a tx memory pool.
   *
   * @private
   * @type {[]}
   */
  private busyLocksQueue: {
    internal: BusyLockQueue[];
    external: BusyLockQueue[];
  } = { internal: [], external: [] };

  public shutdown(): void {
    if (this.listenSocket) {
      // Close the listen socket
      us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;

      // Only have a a short while before sigkill
      // Lets try let them finish up then close the app before sigkill can happen
      setTimeout(() => {
        ActiveLogger.info("Stopping HTTP Server");
        this.api.close();
        ActiveLogger.info("Shutting down...");
        process.exit(0);
      }, 1300);
    }
  }

  /**
   * Add process into pending
   *
   */
  public pending(
    entry: ActiveDefinitions.LedgerEntry,
    remoteAddr: string,
    internal = false,
    forceRestart = false
  ): Promise<any> {
    return new Promise<any>(async (resolve, reject) => {

      // This should only matter to broadcast
      // non-broadcast are direct posts. May still need to add checks there
      // but that occurs at a different location
      if (entry.$broadcast && entry.$nodes) {
        // Even though IP is checked, Nothing prevents them sending multiple payloads
        const nodeSpoofCheck = Object.keys(entry.$nodes);
        if (nodeSpoofCheck.length) {
          for (let i = nodeSpoofCheck.length; i--;) {
            const nodeCheck = nodeSpoofCheck[i];
            if (!this.neighbourhood.checkFirewall(remoteAddr, nodeCheck)) {
              return reject("Bad Neighbour Payload");
            }
          }
        }
      }

      if (forceRestart && this.processPending[entry.$umid]) {
        this.destroy(entry.$umid, true);
        delete this.processPending[entry.$umid];
      }

      // Broadcasting or Territoriality Mode
      if (entry.$broadcast) {
        // We may already have the $umid in memory
        if (this.processPending[entry.$umid]) {
          // ActiveLogger.debug(
          //   this.processPending[entry.$umid],
          //   "Broadcast Recieved : " + entry.$umid
          // );
          // Process Assigned?
          if (
            !this.processPending[entry.$umid]?.finished &&
            this.processPending[entry.$umid]?.pid &&
            // If a lead/er we don't need to let sub processor know
            // TODO sometimes this.reference is nullin $nodes related to the #
            !this.processPending[entry.$umid]?.entry?.$nodes?.[this.reference]
              ?.leader
          ) {
            //here needs to output inbound
            ActiveLogger.debug(
              //this.processPending[entry.$umid],
              entry,
              "Broadcast Recieved : " + entry.$umid
            );
            // Find Processor to send in the broadcast message
            const processor = this.findProcessor(
              this.processPending[entry.$umid].pid
            );
            if (processor) {
              processor.send({
                type: "broadcast",
                data: {
                  umid: entry.$umid,
                  nodes: entry.$nodes,
                },
              });
            } else {
              // Not found, Lets just return the umid anyway it may confirm or will timeout
            }
          } else {
            // Add Vote information into current object!
            const pendingEntry = this.processPending[entry.$umid]?.entry;
            if (pendingEntry) {
              // Don't overwrite self from a broadcast
              delete entry.$nodes[this.reference];
              // Merge new node data into existing entry
              pendingEntry.$nodes = { ...pendingEntry.$nodes, ...entry.$nodes };
            }

          }
          if (!entry.$$noreply) {
            this.broadcast(entry.$umid, false, true);
          }
          // maybe pass something so the data isn't sent twice?
          return resolve({
            status: 200,
            //data: { ok: true },
            // SPI uses this to know if the non sending entry node needs fixing
            data: this.processPending[entry.$umid].entry,
            dontRelease: true,
          });
        }
      }

      // Check we don't have it, Process finding may have failed.
      if (!this.processPending[entry.$umid]) {
        // Add to pending (Using Promises instead of http request)
        this.processPending[entry.$umid] = {
          entry,
          resolve: (response: any) => {
            //this.release(entry);

            // Internal transaction if well replies early so need to release
            // if it has SPI error it should return via here anyway
            if (internal && this.processPending[entry.$umid]?.responded) {
              this.release(entry.$umid);
            }

            if (this.processPending[entry.$umid]) {
              this.processPending[entry.$umid].finished = true;
            }
            if (!this.processPending[entry.$umid]?.responded) {
              resolve(response);

              try {
                this.processPending[entry.$umid].responded = true;
                ActiveLogger.debug("Client Response TX : " + entry.$umid);
              } catch { }
            }
          },
          reject: (response: any) => {
            //setTimeout(() => {
            //this.release(entry);
            if (this.processPending[entry.$umid]) {
              this.processPending[entry.$umid].finished = true;
            }
            if (!this.processPending[entry.$umid]?.responded) {
              reject(response);
              try {
                this.processPending[entry.$umid].responded = true;
              } catch { }
            }
            //}, 10);
          },
          pid: 0,
          finished: false,
          responded: false,
        };
        // Need to check it doesn't exist
        // If this was the entry node it already chhecked so filter
        if (entry.$tx.$expire && remoteAddr !== this.host) {
          if (await this.dbConnection.exists(`${entry.$umid}:umid`)) {
            if (entry.$nodes) {
              entry.$nodes[this.reference] = {
                vote: false,
                commit: false,
                error: `Transaction Exists : ${entry.$umid}`,
              };
            } else {
              entry.$nodes = {
                [this.reference]: {
                  vote: false,
                  commit: false,
                  error: `Transaction Exists : ${entry.$umid}`,
                },
              };
            }
            return this.processPending[entry.$umid].resolve({
              status: 200,
              data: entry,
            });
          }
        }

        this.processQueue(entry, internal);

        // If this is internal and broadcast should just resolve? Why hold it open for the first one.
        if (internal && entry.$broadcast) {
          this.processPending[entry.$umid].responded = true;
          return resolve({
            status: 200,
            data: { ok: true },
            dontRelease: true,
          });
        }
      } else {
        // If we have it and didn't find it, Lets return this request, However
        // do we need to manage the existing one? Possibly stuck? play safe
        // resolve with what we know
        return resolve({
          status: 200,
          data: this.processPending[entry.$umid].entry,
          dontRelease: true,
        });
      }
    });
  }

  /**
   * Creates an instance of Host.
   */
  constructor() {
    super();

    // Cache db from options
    let db = ActiveOptions.get<any>("db", {});

    // Create connection string
    this.dbConnection = new ActiveDSConnect(db.url + "/" + db.database);
    this.dbConnection.info();

    // Create connection string
    this.dbErrorConnection = new ActiveDSConnect(db.url + "/" + db.error);
    this.dbErrorConnection.info();

    // Create connection string
    this.dbEventConnection = new ActiveDSConnect(db.url + "/" + db.event);
    this.dbEventConnection.info();

    // Build Hybrid Node List
    this.hybridHosts = ActiveOptions.get<ActiveDefinitions.IHybridNodes[]>(
      "hybrid",
      []
    );

    // Set hybrid doc name
    if (this.hybridHosts.length) {
      for (let i = this.hybridHosts.length; i--;) {
        const hybrid = this.hybridHosts[i];
        hybrid.docName = ActiveCrypto.Hash.getHash(hybrid.url + hybrid.auth);
      }
    }

    // this.api = createServer((socket) => {
    //   let dBuf: Buffer[] = [];
    //   let headersEnded: number;
    //   let method: string, path: string, headers: any, httpVersion: string;
    //   socket.setKeepAlive(true);

    //   socket.on("error", (e) => {
    //     socket.destroy();
    //   });

    //   socket.on("close", () => {
    //     socket.end();
    //   });

    //   socket.on("data", async (data) => {
    //     // Store as it "may not be enough"
    //     dBuf.push(data);

    //     if (!headersEnded) {
    //       headersEnded = data.indexOf("\r\n\r\n");
    //       const requestHeader = data.subarray(0, headersEnded).toString();
    //       const [firstLine, ...otherLines] = requestHeader.split("\n");
    //       [method, path, httpVersion] = firstLine.trim().split(" ");
    //       headers = Object.fromEntries(
    //         otherLines
    //           .filter((_) => _)
    //           .map((line) => line.split(":").map((part) => part.trim()))
    //           .map(([name, ...rest]) => [name, rest.join(" ")])
    //       );
    //     }

    //     if (method === "POST") {
    //       // Only support content length (this is lowercase! I  think lower case all) as I am not setting
    //       const contentLength = parseInt(
    //         headers["Content-Length"] || headers["content-length"]
    //       );
    //       let body = Buffer.concat(dBuf).subarray(
    //         headersEnded + 4,
    //         contentLength + headersEnded + 4
    //       );
    //       if (body.length >= contentLength) {
    //         // gzipped?
    //         // Sometimes internal transactions fail to be decompressed
    //         // the header shouldn't be missing but added magic number check as a back
    //         // all internal transactions are supposed to be compressed failsafe check for when header isn't available?
    //         if (
    //           headers["content-encoding"] == "gzip" ||
    //           (body[0] == 0x1f && body[1] == 0x8b)
    //         ) {
    //           try {
    //             body = await ActiveGZip.ungzip(body);
    //           } catch (e) {
    //             // Just incase the magic number still invalid gzip
    //             // capture the "incorrect header check" -3 Z_DATA_ERROR and continue
    //             // with the original non-gzip compliant data
    //           }
    //         }

    //         // TODO
    //         // Fix this makesurenot buffer mess I think it is the sending client

    //         //const bodyString = body.toString();
    //         const bodyString = (await this.makeSureNotBuffer(body)) as any;

    //         // could make this nicer
    //         let bundles: any[]; // = [];

    //         // TODO we could have the double buffer problem here?
    //         // unless this has been solved
    //         if (headers["X-Bundle"]) {
    //           bundles = bodyString.split(":$ALB:");

    //           // Now we could also just close the socket! We don't need to reply

    //           socket.write(`HTTP/1.1 200 OK\r\n`);
    //           //socket.write(`Connection: close\r\n`);
    //           socket.write(`Content-Type: application/json\r\n`);
    //           socket.write(`Content-Length: 2\r\n\r\n`);
    //           socket.write("{}");

    //           // Forces "other side closed" error on the client
    //           // socket.write("{}", () => {
    //           //   socket.end();
    //           // });

    //           // Terrible make better just for testing
    //           (socket as any).bundled = true;
    //         } else {
    //           bundles = [bodyString];
    //         }

    //         for (let i = bundles.length; i--; ) {
    //           // All posted data should be JSON
    //           // Convert data for potential encryption
    //           Endpoints.postConvertor(
    //             this,
    //             bundles[i],
    //             (headers["x-activeledger-encrypt"] as unknown as boolean) ||
    //               false
    //           )
    //             .then((body) => {
    //               // Post Converted, Continue processing
    //               this.processEndpoints(
    //                 {
    //                   headers,
    //                   method,
    //                   url: path,
    //                   connection: {
    //                     remoteAddress:
    //                       socket.remoteAddress?.toString() || "unknown",
    //                   },
    //                 },
    //                 socket,
    //                 body.body,
    //                 body.from
    //               );
    //             })
    //             .catch((error) => {
    //               // Failed to convery respond;
    //               ActiveLogger.error(error, "Server POST Parser 500");
    //               this.writeResponse(
    //                 socket,
    //                 error.statusCode || 500,
    //                 JSON.stringify(error.content || { error: 1 }),
    //                 headers["Accept-Encoding"] as string
    //               );
    //             })
    //             .finally(() => {
    //               // reuse if not closed
    //               dBuf = [];
    //               headersEnded = 0;
    //               method = path = httpVersion = "";
    //               (socket as any).bundled = false;
    //             });
    //         }
    //       }
    //     } else {
    //       if (method === "OPTIONS") {
    //         await this.writeResponse(socket, 200, "{}", "", true);
    //       } else {
    //         // Simple get, Continue Processing
    //         // should be safe to await here to capture undefined and promises to clear below
    //         // TODO actually make this flow better as when undefined its an internal then
    //         // process which *could* still be running. Although even if it is resetting below
    //         // should still be safe.
    //         await this.processEndpoints(
    //           {
    //             headers,
    //             method,
    //             url: path,
    //             connection: {
    //               remoteAddress: socket.remoteAddress?.toString() || "unknown",
    //             },
    //           },
    //           socket
    //         );
    //       }

    //       // reuse if not closed
    //       dBuf = [];
    //       headersEnded = 0;
    //       method = path = httpVersion = "";
    //     }
    //   });
    // });

    this.api = App();

    this.api.any("/*", async (res, req) => {
      /* Can't return or yield from here without responding or attaching an abort handler */
      res.onAborted(() => {
        res.writable = false;
      });
      res.writable = true;

      const headers = {
        "Accept-Encoding": req.getHeader("accept-encoding"),
        "X-Activeledger": req.getHeader("x-activeledger"),
        "x-activeledger-encrypt": req.getHeader("x-activeledger-encrypt"),
        "content-encoding": req.getHeader("content-encoding"),
        "X-Bundle": req.getHeader("x-bundle"),
      };

      const method = req.getMethod().toUpperCase();
      const url = req.getUrl();

      let ipFrom = Buffer.from(
        res.getProxiedRemoteAddressAsText().byteLength
          ? res.getProxiedRemoteAddressAsText()
          : res.getRemoteAddressAsText()
      ).toString();

      if (ipFrom.indexOf(":") !== -1) {
        // Convert it to ip4 (this should be save as just for firewall)
        const ip6 = this.parseIp6(ipFrom);
        ipFrom =
          (ip6[6] >> 8) +
          "." +
          (ip6[6] & 0xff) +
          "." +
          (ip6[7] >> 8) +
          "." +
          (ip6[7] & 0xff);
      }

      if (method === "POST") {
        // Read from Buffer
        let body = await this.readBuffer(res);

        // res.onAborted(()=>{
        //   ActiveLogger.fatal("ABORTED?!?!?");
        // })

        //if (body.length >= contentLength) {
        // gzipped?
        // Sometimes internal transactions fail to be decompressed
        // the header shouldn't be missing but added magic number check as a back
        // all internal transactions are supposed to be compressed failsafe check for when header isn't available?
        if (
          headers["content-encoding"] == "gzip" ||
          (body[0] == 0x1f && body[1] == 0x8b)
        ) {
          try {
            body = await ActiveGZip.ungzip(body);
          } catch (e) {
            // Just incase the magic number still invalid gzip
            // capture the "incorrect header check" -3 Z_DATA_ERROR and continue
            // with the original non-gzip compliant data
          }
        }

        // TODO
        // Fix this makesurenot buffer mess I think it is the sending client

        //const bodyString = body.toString();
        const bodyString = (await this.makeSureNotBuffer(body)) as any;

        // could make this nicer
        let bundles: any[]; // = [];

        // TODO we could have the double buffer problem here?
        // unless this has been solved
        if (headers["X-Bundle"]) {
          bundles = bodyString.split(":$ALB:");

          res.cork(() => {
            res.writeStatus("200");
            res.writeHeader("Content-Type", "application/json");
            res.end("{}");
          });
          res.writable = false;
        } else {
          bundles = [bodyString];
        }
        for (let i = bundles.length; i--;) {
          if (bundles[i]) {
            // All posted data should be JSON
            // Convert data for potential encryption
            Endpoints.postConvertor(
              this,
              bundles[i],
              (headers["x-activeledger-encrypt"] as unknown as boolean) || false
            )
              .then((body) => {
                // Post Converted, Continue processing
                this.processEndpoints(
                  {
                    headers,
                    method,
                    url,
                    connection: {
                      remoteAddress: ipFrom,
                    },
                  },
                  res,
                  body.body,
                  body.from
                );
              })
              .catch((error) => {
                // Failed to convery respond;
                ActiveLogger.error(error, "Server POST Parser 500");
                this.writeResponse(
                  res,
                  error.statusCode || 500,
                  JSON.stringify(error.content || { error: 1 }),
                  headers["Accept-Encoding"] as string
                );
              })
              .finally(() => {
                // reuse if not closed
                // dBuf = [];
                // headersEnded = 0;
                // method = path = httpVersion = "";
                // (socket as any).bundled = false;
              });
          }
        }
        //}
      } else {
        if (method === "OPTIONS") {
          await this.writeResponse(res, 200, "{}", "", true);
        } else {
          // Simple get, Continue Processing
          // should be safe to await here to capture undefined and promises to clear below
          // TODO actually make this flow better as when undefined its an internal then
          // process which *could* still be running. Although even if it is resetting below
          // should still be safe.
          await this.processEndpoints(
            {
              headers,
              method,
              url,
              connection: {
                remoteAddress: ipFrom,
              },
            },
            res
          );
        }

        // // reuse if not closed
        // dBuf = [];
        // headersEnded = 0;
        // method = path = httpVersion = "";
      }
    });

    // How many threads (Cache so we can check on ready)
    const cpuTotal =
      parseInt(ActiveOptions.get<string>("cpus", "0")) || PhysicalCores.count();

    // Setup Processors
    const latestSetupMsg = this.getLatestSetup();
    for (let i = 0; i < cpuTotal; i++) {
      // Add process into array
      const processor = this.createProcessor(cpuTotal);
      // Add to list
      this.processors.push(processor);
      // Setup
      processor.send(latestSetupMsg);
    }

    // Create temporary ready to swap out (So it is already set up)
    this.standbyProcess = this.createProcessor(cpuTotal);
    this.standbyProcess.send(latestSetupMsg);

    // Setup Iterator
    this.processorIterator = this.processors[Symbol.iterator]();

    // Start queue failsafe
    this.timerQueue();
  }

  private readBuffer(res: HttpResponse): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0);

      res.onData((ab, isLast) => {
        if (res.aborted) {
          reject(new Error("Request aborted"));
          return;
        }

        if (ab.byteLength > 0) {
          // I found some non-last onData with 0 byte length
          //const copy = copyArrayBuffer(ab); // Immediately copy the ArrayBuffer into a Buffer, every return of onData neuters the ArrayBuffer
          //totalSize += copy.byteLength;
          buffer = Buffer.concat([buffer, Buffer.from(ab)]);
        }

        if (isLast) {
          // If this is the last chunk, process the final buffer
          // Convert the buffer to a string and parse it as JSON
          // this will fail if the buffer doesn't contain a valid JSON (e.g. length = 0)
          //const resolveValue = JSON.parse(buffer.toString());
          resolve(buffer);
        }
      });
    });
  }

  // https://stackoverflow.com/questions/2786632/how-can-i-convert-ipv6-address-to-ipv4-address/23147817#23147817
  private parseIp6(str: string) {
    //init
    var ar = new Array();
    for (var i = 0; i < 8; i++) ar[i] = 0;
    //check for trivial IPs
    if (str == "::") return ar;
    //parse
    var sar = str.split(":");
    var slen = sar.length;
    if (slen > 8) slen = 8;
    var j = 0;
    for (var i = 0; i < slen; i++) {
      //this is a "::", switch to end-run mode
      if (i && sar[i] == "") {
        j = 9 - slen + i;
        continue;
      }
      ar[j] = parseInt("0x0" + sar[i]);
      j++;
    }

    return ar;
  }

  private async makeSureNotBuffer(obj: unknown): Promise<unknown>;
  private async makeSureNotBuffer(obj: {
    type: string;
    data: number[];
  }): Promise<unknown> {
    if (obj.type === "Buffer" && obj.data?.length) {
      // This shouldn't be like that
      // Question is why and where this happens. This solution comes across in research
      // as a global coverage as so far "$i undefined" has has a Buffer with $i instead!
      // Appears to be compressed then turned into a buffer string that gets parsed
      // so probably writer converting but It isn't everytime?
      //ActiveLogger.error(tmp, "Buffer Found");
      if (obj.data[0] == 0x1f && obj.data[1] == 0x8b) {
        return (await ActiveGZip.ungzip(Buffer.from(obj.data))).toString();
      }
      return Buffer.from(obj.data).toString();
    }

    if (Buffer.isBuffer(obj)) {
      if (obj[0] == 0x1f && obj[1] == 0x8b) {
        return (await ActiveGZip.ungzip(obj)).toString();
      }
      const tmp = obj.toString();

      if (tmp.startsWith('{"type":"Buffer"')) {
        const asBufferObj = JSON.parse(tmp);

        if (asBufferObj.data[0] == 0x1f && asBufferObj.data[1] == 0x8b) {
          return (
            await ActiveGZip.ungzip(Buffer.from(asBufferObj.data))
          ).toString();
        }
        return Buffer.from(asBufferObj.data).toString();
      }
      return obj.toString();
    }

    // It should be normal just return!
    return obj;
  }

  /**
   * Retuns latest setup for a subprocess
   *
   * @private
   * @returns {setup}
   */
  private getLatestSetup(): setup {
    // Temp fix to circular problem on crash?
    // Problem with this is it assume right may not have changed
    // everythiung else should be static!
    return {
      type: "setup",
      data: {
        self: Home.host,
        reference: Home.reference,
        right: Home.right,
        neighbourhood: this.neighbourhood.get(),
        pubPem: Home.publicPem,
        privPem: Home.identity.pem,
        db: ActiveOptions.get<any>("db", {}),
        __base: ActiveOptions.get("__base", __dirname),
      },
    };
  }

  /**
   * Creator a processor thread (by process)
   *
   * @private
   * @returns {ChildProcess}
   */
  private createProcessor(cpuTotal?: number): ChildProcess {
    // Create Process
    const pFork = fork(`${__dirname}/process.js`, [], {
      cwd: process.cwd(),
      stdio: "inherit",
    }) as StoppableChildProcess;

    // Set useful default
    pFork.stop = false;

    // Prevent multiple runs, Could overwrite method instead
    let unloadHandled = false;

    // Reusable restart process from error with current scope
    const unloadProcessorSafely = (...error: any[]) => {
      if (unloadHandled || !this.listenSocket) {
        //ActiveLogger.fatal(error, "Processor Crashed - Already Shutting Down");
      } else {
        pFork.stop = unloadHandled = true;
        ActiveLogger.fatal(error, "Processor Crashed");

        // Push standby process
        this.processors.push(this.standbyProcess);

        // We should now create a new standby processor
        this.standbyProcess = this.createProcessor();
        //this.standbyProcess.send(this.getLatestSetup());

        setTimeout(() => {
          this.standbyProcess.send(this.getLatestSetup(), (e) => {
            if (e) {
              ActiveLogger.fatal(e as any, "Issue with new Standby Process");
              // Send it again?
            }
          });
        }, 1000);

        ActiveLogger.fatal(
          pFork,
          "Will Gracefully Shutdown in " + GRACEFUL_PROC_SHUTDOWN
        );
        // Wait for current tansactions to finish (Destroy can take up to 5 minutes)
        setTimeout(() => {
          // Look for any transactions which are in this processor
          ActiveLogger.fatal(pFork, "Starting Graceful Shutdown");
          const pendings = Object.keys(this.processPending);
          pendings.forEach((key) => {
            // Get Transaction
            let pending = this.processPending[key];
            // Was this transaction in the broken processor
            if (pending?.pid === pFork.pid) {
              // This will just resolve all pending transactions in that process pool
              // Wont be graceful but most likely other nodes will have the same conclusion
              // However enough time has passed that it *should* be safe
              // TODO make sure we don't have a single transaction forever extending timeout.
              // Or find a way to move it into another process broadcast timeout is within the 5 minutes
              // Assign general error
              pending.entry.$nodes[this.reference].error =
                "(Contract Thread Error) Unknown - Try Again";

              // Resolve to return oprhened transactions
              pending.resolve({
                status: 200,
                data: pending.entry,
              });

              // setTimeout(() => {
              //   // Remove Locks
              //   this.release(pending);
              // }, 500);
            }
          });

          // Instruct child to terminate. (Clears memory)
          // Even though we should be clear timeout to act as a buffer and
          // push to the end of the event loop
          ActiveLogger.fatal(pFork, "Will Kill in " + KILL_PROC_SHUTDOWN);
          setTimeout(() => {
            ActiveLogger.fatal(pFork, "Sending Kill Signal");
            //Find the bad process
            for (let i = this.processors.length; i--;) {
              if (this.processors[i].pid === pFork.pid) {
                this.processors.splice(i, 1);
                break;
              }
            }
            // const pos = this.processors.findIndex((processor) => {
            //   return processor.pid === pFork.pid;
            // });

            // // Remove from processors list and create new
            // if (pos !== -1) {
            //   this.processors.splice(pos, 1, this.standbyProcess);
            // }
            pFork.kill();
          }, KILL_PROC_SHUTDOWN);
          // Contracts which extend timeout will still be at risk hence the above
        }, GRACEFUL_PROC_SHUTDOWN);
      }
    };

    // Listen for message to respond to waiting http
    pFork.on("message", (m: any) => {
      // Cache Pending Reference
      const pending = this.processPending[m.data.umid];

      // Process may have been cleared by unhandleded process crashing
      if (pending) {
        // Check data for self to update
        // if its early to spread the transaction we don't know its value yet? (will default to false)
        if (m.data.nodes && !m.data.early) {
          pending.entry.$nodes = {
            ...pending.entry.$nodes,
            ...m.data.nodes,
          };
        }

        // Check for revisions if they have been added
        if (m.data.revs && !pending.entry.$revs) {
          pending.entry.$revs = {
            $i: m.data.revs.$i || {},
            $o: m.data.revs.$o || {},
          };
        }
      }

      // Switch on type of messages from processors
      switch (m.type) {
        case "failed":
          if (!pending) return; // Fail safe, May happen when process being closed
          // So if we send as resolve it should still work (Will it keep our error?)
          pending.resolve({
            status: 200,
            data: m.data.entry
              ? { ...pending.entry, ...m.data.entry }
              : pending.entry,
          });

          // If we want to send AFTER this node has completed uncomment
          // If Hybrid enabled, Send transaction on
          // if (m.data && this.hybridHosts.length) {
          //   this.processHybridNodes(pending.entry);
          // }
          break;
        case "commited":
          if (!pending) return; // Fail safe, May happen when process being closed
          // Process response back into entry for previous neighbours to know the results
          pending.resolve({
            status: 200,
            data: { ...pending.entry, ...m.data.entry },
          });
          // If we want to send AFTER this node has completed uncomment
          // If Hybrid enabled, Send transaction on
          if (this.hybridHosts.length) {
            // TODO : TypeError: Cannot read property '$streams' of undefined
            this.processHybridNodes(pending.entry, m.data.entry?.$streams);
          }
          break;
        case "broadcast":
          this.broadcast(m.data.umid, m.data.early);
          break;
        case "reload":
          this.reload();
          break;
        case "ready":
          // Check that we should be counting
          if (cpuTotal) {
            // Increase Ready Counter
            this.cpuReady++;
            // If not listening and have enough cpu returns (Covers crashes)
            if (!this.listeing && this.cpuReady >= cpuTotal) {
              // Listen to the Neighbourhood
              this.listeing = true;
              this.api.listen(
                ActiveInterfaces.getBindingDetails("port") as unknown as number,
                (token: us_listen_socket) => {
                  this.listenSocket = token;
                  ActiveLogger.info(
                    "Activeledger listening on port " +
                    ActiveInterfaces.getBindingDetails("port")
                  );
                }
              );
              Maintain.healthTimer(true);
            }
          }
          break;
        case "unhandledrejection":
          if (pending) {
            pending.resolve({
              status: 200,
              data: { ...pending.entry, ...m.data.entry },
            });

            // setTimeout(() => {
            //   // Remove Locks
            //   this.release(pending);
            // }, 500);
          }
          if (!m.data.recoverable) {
            // End process and create new subprocess
            unloadProcessorSafely(
              "unhandledrejection - Already Handled, Tidying up processes"
            );
          }
          break;
        case "contractData":
        case "contractLatestVersion":
          // Let other processes know of new version
          this.processors.forEach((processor) => {
            processor.send(m);
          });
          // No need to send to standby it hasn't processed the transaction
          break;
        case "memory":
          // End process and create new subprocess
          unloadProcessorSafely(
            `High Memory Load (${m.data.rss / 1024 / 1024}mb)`
          );
          break;
        default:
          ActiveLogger.fatal(m, "Unknown IPC Call");
          break;
      }
    });

    // Recreate a new subprocessor
    pFork.on("error", unloadProcessorSafely);

    return pFork;
  }

  private listeing = false;

  /**
   * Reload the configuration
   *
   * @private
   */
  private reload() {
    // Reload Neighbourhood
    ActiveOptions.extendConfig()
      .then((config: any) => {
        if (config.neighbourhood) {
          ActiveLogger.debug(config.neighbourhood, "Reset Request");

          // Reference would have changed
          Home.reference = this.reference = ActiveCrypto.Hash.getHash(
            this.host + this.port + ActiveOptions.get<string>("network", ""),
            "sha1"
          );

          // Prepare self for reset
          Home.left = new Neighbour(this.host, this.port);
          Home.right = new Neighbour(this.host, this.port);

          // Reset Network
          this.neighbourhood.reset(config.neighbourhood);

          // Rebuild Network Territory Map
          this.terriBuildMap();
        }

        // Now to make sure all other processors reload
        const reloadMsg = {
          type: "reload",
          data: {
            reference: Home.reference,
            right: Home.right,
            neighbourhood: this.neighbourhood.get(),
          },
        };
        this.processors.forEach((processor) => {
          processor.send(reloadMsg);
        });
        this.standbyProcess.send(reloadMsg);
      })
      .catch((e: any) => {
        ActiveLogger.info(e, "Failed to reload Neighbourhood");
      });
  }

  /**
   * Attempt to clear memory for GV
   *
   * @private
   * @param {*} umid
   */
  private destroy(umid: string, skipTimeout = false): void {
    // Make sure it hasn't ben removed already
    if (this.processPending[umid]) {
      // Set to shutdown so broadcast can stop
      this.processPending[umid].shutdown = true;

      // Pass destory message to processor
      this.findProcessor(this.processPending[umid].pid)?.send({
        type: "destory",
        data: {
          umid,
          skipTimeout,
        },
      });

      if (!skipTimeout) {
        // Keep in memory to manage inbound broadcasts
        setTimeout(() => {
          delete this.processPending[umid];
        }, RELEASE_DELETE_TIMEOUT);
      }
    }
  }

  /**
   * Broadcast Transaction to the network
   *
   * @private
   * @param {string} umid
   */
  private broadcast(umid: string, early = false, noreply = false): void {
    // Final check object exists
    if (
      this.processPending[umid]?.entry &&
      this.processPending[umid].entry.$broadcast &&
      this.processPending[umid].entry.$nodes &&
      //this.processPending[umid].entry.$nodes[this.reference] && // early wont have this now
      (early ||
        (this.processPending[umid].entry.$nodes[this.reference] &&
          "vote" in this.processPending[umid].entry.$nodes[this.reference])) // only return if there is a vote or early
      //(!noreply && !this.processPending[umid].finished) // Only send if not finished, if finished we have no real interest
    ) {
      ActiveLogger.debug(`Broadcasting TX ($$NR ${noreply}) : ` + umid);

      // Get all the neighbour nodes
      let neighbourhood = this.neighbourhood.get();
      let nodes = this.neighbourhood.keys();
      let promises: any[] = [];

      // Skip sending if leader
      // TODO detect leader!
      //this.processPending[umid].entry.$nodes

      // We only want to send our value
      const data = (!early || !this.processPending[umid].entry.$nodes[this.reference].early)
        ? Object.assign(this.processPending[umid].entry, {
          $nodes: {
            [this.reference]:
              this.processPending[umid].entry.$nodes[this.reference],
          },
        })
        : Object.assign(this.processPending[umid].entry, {
          $nodes: {},
        });

      // We need a proper copy to modify that way we still keep the original in memory for the tx
      // const data = JSON.parse(
      //   JSON.stringify(this.processPending[umid].entry || {})
      // );
      // if (!early) {
      //   data.$nodes = {
      //     [this.reference]:
      //       this.processPending[umid].entry.$nodes[this.reference],
      //   };
      // } else {
      //   data.$nodes = {};
      // }
      // Above will rarely change we should find a way to cache it

      // Experienced a blank target from above assign, Double check to prevent bad loop
      if (data) {
        data.$$noreply = noreply;
        if (early) {
          // If early we don't need a response
          data.$$noreply = true;
        }
        // Loop them all and broadcast the transaction
        for (let i = nodes.length; i--;) {
          let node = neighbourhood[nodes[i]];
          // TODO the entry.$nodes check only valid for leader? It can probably be reduced for non leaders

          // Make sure they're home and not us
          if (
            node.isHome &&
            node.reference !==
            this
              .reference /*&& !this.processPending[umid].entry.$nodes[node.reference]*/
          ) {
            // Need to detect if we have already sent and got response for nodes for performance
            promises.push(node.knock("init", data, false, 0, true));
          }
        }

        // Listen for promises
        Promise.all(promises)
          .then(() => {
            // As it is bundled we don't get a response. We need to trigger rebroadcast
          })
          .catch(() => {
            // Keep broadcasting until promises fully resolve
            // Could be down nodes (So they can have 5 minute window to get back up)
            // Or connection issues. This doesn't stop commit phase as they will eventually call us.
            setTimeout(() => {
              this.broadcastResolver(umid);
            }, 250);
          });
      }
    }
  }

  /**
   * Resolves broadcasted results
   *
   * @private
   * @param {string} umid
   */
  private broadcastResolver(umid: string): void {
    // Check access to the protocol
    if (this.processPending[umid] && this.processPending[umid].entry) {
      // Recast as connection errors found.
      ActiveLogger.warn("Rebroadcasting : " + umid);
      this.broadcast(umid);
    } else {
      // No longer in memory. Create a new error document outside protocol
      // We could have comitted but no idea we may have needed a rebroadcast back.
      const doc = {
        code: 1610,
        processed: false,
        umid: umid,
        // simulate tx for restore
        transaction: {
          $broadcast: true,
          $tx: {},
          $revs: {},
        },
        reason: "Failed to rebroadcast while in memory",
      };

      // Return
      this.dbErrorConnection.post(doc);
    }
  }

  /**
   * TODO: Need to merge with labelOrKey@protocol/process.ts
   *
   * @private
   * @param {*} txIO
   * @param {boolean} [outputs=false]
   * @returns {string[]}
   */
  private labelOrKey(txIO: any): string[] {
    // Get reference for input or output
    const keys = Object.keys(txIO || {});
    const out: string[] = [];

    for (let i = keys.length; i--;) {
      // So we can have multisig without having to hold lock on same stream
      if (!txIO[keys[i]].$sigOnly) {
        // Stream label or self
        out.push(this.filterPrefix(txIO[keys[i]].$stream || keys[i]));
      }
    }
    return out;
  }

  /**
   * Filters Prefix for labelorkey locking
   *
   * @private
   * @param {string} streamId
   * @returns {string}
   */
  private filterPrefix(streamId: string): string {
    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      streamId = streamId.slice(-64);
    }

    // Return just the id
    return streamId;
  }

  /**
   * Trigger a hold of the stream locks that the process wants to own
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @param {number} retries
   */
  private hold(v: ActiveDefinitions.LedgerEntry, retries = 0): boolean {
    // Build a list of streams to lock
    // Would be good to cache this
    // let input = Object.keys(v.$tx.$i || {});
    // let output = Object.keys(v.$tx.$o || {});

    // Ask for locks
    // Use set to filter unique then back to array (or in loop)

    if (!v.$$labelOrKey) {
      const outputs = this.labelOrKey(v.$tx.$o);
      if (!v.$selfsign) {
        v.$$labelOrKey = [
          ...new Set([...this.labelOrKey(v.$tx.$i), ...outputs]),
        ];
      } else {
        v.$$labelOrKey = outputs;
      }
    }

    if (
      // Selfsigning and can lock on output if any
      // don't need to use set for unique
      Locker.hold(v.$$labelOrKey, v.$umid)
    ) {
      // Get next process from the array
      const robin = this.getRobin();
      // Make sure we have the response object
      if (!this.processPending[v.$umid].entry.$nodes)
        // Make sure it exists
        if (!this.processPending[v.$umid].entry.$nodes) {
          this.processPending[v.$umid].entry.$nodes = {};
        }

      // Setup this node response
      this.processPending[v.$umid].entry.$nodes[Home.reference] = {
        vote: false,
        commit: false,
        early: true
      };

      // Remember who got selected
      this.processPending[v.$umid].pid = robin.pid || 0;

      //setTimeout(() => {
      // Pass transaction to sub processor
      robin.send({
        type: "tx",
        entry: this.processPending[v.$umid].entry,
      });
      // small scaling delay to put to back of stack
      //}, retries * 1);

      // If we want to send BEFORE this node has processed uncomment
      // if (this.hybridHosts.length) {
      //   this.processHybridNodes(this.processPending[v.$umid].entry);
      // }

      return true;
    } else {
      if (v.$nolock) {
        if (v.$broadcast) {
          // Other nodes will hang, posibly just defautl to vote no
          this.processPending[v.$umid].entry.$nodes = {
            [this.reference]: {
              vote: false,
              commit: false,
              error: "Busy Locks",
            },
          };
          this.broadcast(v.$umid, false, true);
          // How long does it stay in memory I wonder
          ActiveLogger.warn(
            this.processPending[v.$umid],
            `${v.$umid} busy lock broadcasting that fact`
          );
        }
        this.processPending[v.$umid].reject({
          status: 100,
          error: "Busy Locks",
        });
      } else {
        if (retries === 0) {
          // Push to the end of the queue
          (v.$revs
            ? this.busyLocksQueue.internal
            : this.busyLocksQueue.external
          ).push({
            running: false,
            entry: v,
            retry: 1,
          });
        } else {
          // Detect internal transaction read below for more information
          const internal = v.$revs ? true : false;
          // const maxRetries = internal
          //   ? 2
          //   : ActiveOptions.get<number>("queue_retry", 5);

          // We could set this really high as every new transaction (unrelated) will increase
          // the counter. So it will eventually send (unless crashed) no matter how high
          // so possibly a safe timeout should be used.
          if (retries > ActiveOptions.get<number>("queue_retry", MAX_RETRIES)) {
            // $origin check will mean if this is the entry node and is locked it will
            // still send around the network. Broadcast will fail. So for now if entry is locked
            // defaulting to queue attempt to unlock. Otherwise busy locks could be spammed. Doesn't mean
            // in the future we can enable it. For now if entry node isn't locked then it will continue regardless
            if (/*v.$origin || */ internal) {
              // Internal Request (So need to respond as expected + forward on if not broadcast)
              // Some network conditions wont have this set
              if (!v.$nodes) {
                v.$nodes = {};
              }
              v.$nodes[this.reference] = {
                vote: false,
                commit: false,
                error: "IBL01",
              };

              // Internal Busy Locks, Safe to track
              // const doc = {
              //   code: 1100,
              //   processed: false,
              //   umid: v.$umid,
              //   transaction: v,
              //   locker: Locker.getLocks(),
              //   reason: "Internal Busy Locks",
              // };

              // // Return
              // this.dbErrorConnection.post(doc);

              // Not Broadcast & Not Last
              if (!v.$broadcast && Home.right.reference != v.$origin) {
                // Forward on to the next node and compile responses back
                (async () => {
                  const next = await Home.right.knock("init", v);
                  this.processPending[v.$umid].resolve({
                    status: 200,
                    data: { ...v, ...next.data },
                  });
                })();
              } else {
                this.broadcast(v.$umid, false, true);
                // Respond back with our failure
                this.processPending[v.$umid].resolve({
                  status: 200,
                  data: v,
                });
              }
            } else {
              // External Request
              this.processPending[v.$umid].reject({
                status: 100,
                error: "Busy Locks",
              });
            }

            // Not always safe but i/o position incorrect will help
            //this.release(this.processPending[v.$umid]);
            // True so it is "handled" and removed from the queue in a single location
            return true;
          }
        }
      }
      return false;
    }
  }

  /**
   * Gets next processor in the list (Doesn't account for load)
   *
   * @private
   * @returns {ChildProcess}
   */
  private getRobin(): ChildProcess {
    // Get next processes in queue
    let robin = this.processorIterator.next().value;

    // Do we need to reset?
    if (!robin) {
      this.processorIterator = this.processors[Symbol.iterator]();
      return this.getRobin();
    }

    // Has this processor been told to stop
    if (robin.stop) {
      return this.getRobin();
    }

    return robin;
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {string} v
   * @param {boolean} noWait Don't wait to release
   */
  //private release(entry: ActiveDefinitions.LedgerEntry) {
  public release(umid: string) {
    if (this.processPending[umid]) {
      const entry = this.processPending[umid].entry;
      // Ask for releases
      Locker.release(
        [...this.labelOrKey(entry.$tx.$i), ...this.labelOrKey(entry.$tx.$o)],
        entry.$umid
      );

      // Keep transaction in memory for a bit (5 Minutes)
      setTimeout(() => {
        if (entry) {
          this.destroy(entry.$umid);
        }
      }, RELEASE_SHUTDOWN_TIMEOUT);

      // Put this at the end so the queue can clear this transaction
      setTimeout(() => {
        // Check the lock queue
        this.processQueue();
      }, 200);
    } else {
      ActiveLogger.warn(umid, "Trying to release unknown umid");
    }
  }
  private processingBLQ = false;

  /**
   * Manages the busy lock queue
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} [next]
   */
  private processQueue(next?: ActiveDefinitions.LedgerEntry, internal = false) {
    // If Internal and not broadcast let it skip the queue
    // let skipped = false;
    // if (next && internal /* && !next.$broadcast */) {
    //   this.hold(next);
    //   skipped = true;
    // }

    // Run through the queue in order to process
    if (!this.processingBLQ) {
      this.processingBLQ = true;

      // Checked identities. This prevents trying to lock the same stream multiple times in one queue run.
      const checked2: Set<string> = new Set();

      // Process internal queue first
      if (this.busyLocksQueue.internal.length) {
        const stillPending: BusyLockQueue[] = [];
        busyQueueInternal: for (let i = 0; i < this.busyLocksQueue.internal.length; i++) {
          const labelOrKey = this.busyLocksQueue.internal[i].entry.$$labelOrKey;
          if (labelOrKey?.length) {
            for (const key of labelOrKey) {
              if (checked2.has(key)) {
                continue busyQueueInternal;
              }
              checked2.add(key);
            }
          }

          if (!this.hold(this.busyLocksQueue.internal[i].entry, this.busyLocksQueue.internal[i].retry++)) {
            // If hold fails, add it to the list of items to keep for the next run.
            stillPending.push(this.busyLocksQueue.internal[i]);
          }
        }
        this.busyLocksQueue.internal = stillPending;
      }

      if (next && internal) {
        this.hold(next);
      }

      // Process external queue
      if (this.busyLocksQueue.external.length) {
        const stillPending: BusyLockQueue[] = [];
        for (let i = 0; i < this.busyLocksQueue.external.length; i++) {
          if (!this.hold(this.busyLocksQueue.external[i].entry, this.busyLocksQueue.external[i].retry++)) {
            stillPending.push(this.busyLocksQueue.external[i]);
          }
        }
        this.busyLocksQueue.external = stillPending;
      }

      if (next && !internal) {
        this.hold(next);
      }
      this.processingBLQ = false;
    } else {
      if (next) {
        this.hold(next);
      }
    }
  }

  /**
   * Checks the queue periodically to prevent timeouts
   * better to return as a busy lock
   *
   * @private
   */
  private timerQueue() {
    setTimeout(() => {
      this.processQueue();
      this.timerQueue();
    }, TIMER_QUEUE_INTERVAL);
  }

  /**
   * Manage Hybrid Nodes
   *
   * @private
   * @param {string} tx
   * @param {ActiveDefinitions.IStreams} [activityStreams]
   */
  private processHybridNodes(
    tx: ActiveDefinitions.LedgerEntry,
    activityStreams?: ActiveDefinitions.IStreams
  ) {
    // Skip default/setup as it doesn't help hybrids
    if (
      tx.$tx.$namespace !== "default" ||
      (tx.$tx.$namespace === "default" && tx.$tx.$contract !== "setup")
    ) {
      // Minmum data needed for hybrid to process
      const txData = JSON.stringify({
        $tx: tx.$tx,
        $datatime: tx.$datetime,
        $umid: tx.$umid,
        $selfsign: tx.$selfsign,
        $sigs: tx.$sigs,
        $remoteAddr: tx.$remoteAddr,
      });

      // Loop all hybrids and send
      this.hybridHosts.forEach((hybrid) => {
        if (hybrid.active) {
          ActiveRequest.send(
            hybrid.url,
            "POST",
            ["Content-Type:application/json", "X-Activeledger:" + hybrid.auth],
            txData,
            true
          )
            .then((response) => {
              // Hybrid Active, Has the node missed anything?
              // The below may create a 404 error log.
              this.dbErrorConnection
                .exists(hybrid.docName as string)
                .then((exists: any) => {
                  if (exists && exists.q && exists.q.length) {
                    // Send the queue (no need to wait being best effort)
                    ActiveRequest.send(
                      `${hybrid.url}/q`,
                      "POST",
                      ["X-Activeledger:" + hybrid.auth],
                      exists.q
                    ).catch();

                    // Then delete!
                    this.dbErrorConnection.purge(exists).catch();
                  }

                  // ok = do nothing
                  // unhandledRejection, failed = send latest version
                  const data = response.data as any;

                  // Everything but ok, should see latest version
                  if (data.status !== "ok") {
                    // Get all New / Updated Docs
                    const updated = [
                      ...(activityStreams?.new || []),
                      ...(activityStreams?.updated || []),
                    ].map((stream) => stream.id);

                    // Also need $i, $o and $r,  Can probably reuse the .keys
                    const input = tx.$tx.$i ?
                      this.hybridLabelKeyId(tx.$tx.$i) :
                      [];
                    const output = tx.$tx.$o
                      ? this.hybridLabelKeyId(tx.$tx.$o)
                      : [];

                    // Dupes should be managed (If not switch to set)
                    const keys = [...updated, ...input, ...output];

                    // Missing Contract
                    if (data.contract) {
                      const path = `${process.cwd()}/contracts/${tx.$tx.$namespace
                        }/${tx.$tx.$contract}.js`;
                      // Maybe symlink?
                      try {
                        keys.push(basename(readlinkSync(path), ".js"));
                      } catch (e) {
                        // File is a stream id
                        keys.push(basename(path, ".js"));
                      }
                    }

                    // Loop all and append :stream to get meta data
                    const tmp = [];
                    for (const key of keys) {
                      tmp.push(key + ":stream");
                    }

                    // Push tmp back into keys so we get everything
                    keys.push(...tmp);

                    // Fetch all docs (Dupes should be managed, If not use set)
                    return this.dbConnection
                      .allDocs({
                        include_docs: true,
                        keys,
                      })
                      .then((results) => {
                        // Return the results with the error id
                        if (results.rows.length) {
                          // Can ignore responses
                          return ActiveRequest.send(
                            `${hybrid.url}/streamState/${data.streamState}`,
                            "POST",
                            ["X-Activeledger:" + hybrid.auth],
                            {
                              umid: tx.$umid,
                              streams: results.rows,
                            }
                          );
                        }
                      });
                  }
                });
            })
            .catch(() => {
              // Best Effort Approach
              // Store all failed requests into a error document named after the node
              // Node comes online and pings the mainnet to send this best effort list
              // Whhy best effort?
              // If the node has missed 1000 transactions and it takes 5 seconds a transaction there is a good chance that
              // a new transaction will come in that later relies on one of the missed transactions which may not yet be processed
              // This will tricker the trusted recovery, When that transaction does get caught up it will now also fail by being behind again triggering recovery
              // This recovery will continue to happen until all transactions have finished and with best effort (and duplication) the data should be up to date.
              // Error database can be deleted so this record would be lost and then it would be a slower recovery reason behind "best effort" naming

              // Get Document if exists
              this.dbErrorConnection
                .createget(hybrid.docName as string)
                .then((doc: any) => {
                  // Add the tx to this nodes queue
                  if (doc.q) {
                    doc.q.push(txData);
                  } else {
                    doc.q = [txData];
                  }

                  // Write document back to the database
                  return this.dbErrorConnection.post(doc);
                })
                .catch(() => {
                  // Can Ignore catch for now
                });
            });
        }
      });
    }
  }

  /**
   * Extract stream id from transaction type
   *
   * @private
   * @param {ActiveDefinitions.LedgerIORputs} txIO
   * @returns {string[]}
   */
  private hybridLabelKeyId(txIO: ActiveDefinitions.LedgerIORputs): string[] {
    // Get reference for input or output
    const streams = Object.keys(txIO);

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      const streamMap: string[] = [];
      for (let i = streams.length; i--;) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        streamMap.push(streamId);
      }
      return streamMap;
    } else {
      return streams;
    }
  }

  /**
   * Process Activeledger request endpoints
   *
   * @private
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {*} [body]
   */
  private processEndpoints(
    req: {
      headers: {
        [index: string]: string;
      };
      method: string;
      url: string;
      connection: {
        remoteAddress: string;
      };
    },
    res: HttpResponse,
    body?: any,
    from?: string
  ) {
    // Internal or External Request
    let requester = (req.headers["X-Activeledger"] as string) || "NA";

    // Promise Response
    let response: Promise<any>;

    const started = Date.now();

    // Can we return compressed data?
    let gzipAccepted = req.headers["Accept-Encoding"] as string;

    // Diffrent endpoints VERB
    switch (req.method) {
      case "GET":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/a/locks": // Network Status Request
            return this.writeResponse(
              res,
              200,
              JSON.stringify({ L: Locker.getLocks(), Q: this.busyLocksQueue }),
              gzipAccepted
            );
          case "/a/locks/check": // Network Status Request
            Locker.checkLocks();
            return this.writeResponse(
              res,
              200,
              JSON.stringify({ checked: true }),
              gzipAccepted
            );
          case "/a/status": // Network Status Request
            response = Endpoints.status(this, requester);
            break;
          case "/a/all": // All Stream Management
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              response = Endpoints.all(this.dbConnection);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          // This opens up a dos style attack (loop on every request)
          // case "/hybrid/online": // Hybrid Node starting up
          //   // Loop Hybrids, Find matching auth
          //   const hAuth = req.headers["x-activeledger"] as string;
          //   break;
          default:
            // All Stream Management with start point
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              if (req.url) {
                let match = req.url.substr(0, 7);
                switch (match) {
                  case "/a/all/":
                    response = Endpoints.all(
                      this.dbConnection,
                      req.url.substr(7)
                    );
                    break;
                  case "/a/umid":
                    response = Endpoints.umid(
                      this.dbConnection,
                      req.url.substr(8)
                    );
                    break;
                  default:
                    // 404 Not Found
                    return this.writeResponse(
                      res,
                      404,
                      "Not Found",
                      gzipAccepted
                    );
                }
              } else {
                return this.writeResponse(res, 404, "Not Found", gzipAccepted);
              }
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
        }
        break;
      case "POST":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/": // Setup for accepting external transactions
            response = Endpoints.ExternalInitalise(
              this,
              body,
              req.connection.remoteAddress || "unknown",
              this.dbConnection
            );
            break;
          case "/a/encrypt":
            // Make sure it was encrypted here
            response = Endpoints.ExternalEncrypt(
              this,
              body,
              (req.headers["x-activeledger-encrypt"] as unknown as boolean) ||
              false,
              this.dbConnection
            );
            // Pass db conntection
            break;
          case "/a/init": // Internal transactions
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              response = Endpoints.InternalInitalise(this, body, req.connection.remoteAddress);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          case "/a/stream": // Stream Data Management (Activerestore)
            //if (this.firewallCheck(requester, req)) {
            response = Endpoints.streams(this.dbConnection, body);
            //} else {
            //  return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            // }

            // Check Locks
            // Wait, then check again
            // loop this maybe?
            // Then send response if unlocked (but what if a transaction locks it between timer?)
            // maybe have an event that triggers it on unlock
            // then need to return an error within time. (and deal with that in SPI)

            // m,oving to postprocess will it unlock it quicker??
            break;
          default:
            return this.writeResponse(res, 404, "Not Found", gzipAccepted);
        }
        break;
      default:
        return this.writeResponse(res, 404, "Not Found", gzipAccepted);
    }

    // Wait for promise to get the response
    response
      .then((response: any) => {
        let data = response.content || {};
        // Response should be encrypted?
        if (response.content && response.content.$encrypt && from) {
          data = {
            $packet: this.neighbourhood
              .get(from)
              .encryptKnock(JSON.stringify(response.content), true),
            $enc: true,
          };
        }

        // Write Header 
        // All outputs are JSON and
        if (data.$umid) {
          const TT = Date.now() - started;
          if (TT > 5) {
            // Only output if umid reduce internal 0ms spam (brtoadcast has to respond now for SPI)
            ActiveLogger.info(
              `Request Response ${data.$umid ? data.$umid : "No Umid"
              } : S=${started}, TT=${TT}ms ${TT > 30000 ? "TTLR" : " OK"
              }`
            );
          }
        }
        this.writeResponse(
          res,
          response.statusCode,
          JSON.stringify(data),
          gzipAccepted
        );
      })
      .catch((error: any) => {
        // Write Header
        // Basic error handling for now. As a lot of errors will still be sent as ok responses.
        ActiveLogger.error(error, "Failed to send response back");
        ActiveLogger.info(
          `Request Response ERROR : S=${started}, TT=${Date.now() - started}ms`
        );
        this.writeResponse(
          res,
          error.statusCode || 500,
          JSON.stringify(error.content || "Something has gone wrong"),
          gzipAccepted
        );
      });
  }

  /**
   * Write the response to the brwoser
   *
   * @private
   * @param {ServerResponse} res
   * @param {number} statusCode
   * @param {(string | Buffer)} content
   * @param {string} encoding
   */
  private async writeResponse(
    res: HttpResponse,
    statusCode: number,
    content: string | Buffer,
    encoding: string,
    cors = false
  ) {
    if (!res.writable) {
      return;
    }

    if (content) {
      if (encoding == "gzip") {
        content = await ActiveGZip.gzip(content);
      }
    }

    res.cork(() => {
      res.writeStatus(`${statusCode}`);
      res.writeHeader("Access-Control-Allow-Origin", "*");

      if (cors) {
        res.writeHeader("Access-Control-Allow-Methods", "GET, POST");
        res.writeHeader("Access-Control-Allow-Headers", "*");
      }

      if (content) {
        res.writeHeader("Content-Type", "application/json");
        if (encoding == "gzip") {
          res.writeHeader("Content-Encoding", "gzip");
        }
        res.end(content);
        res.writable = false;
      }
    });
  }

  /**
   * Checks the local paramters to see if connection is allowed
   *
   * @private
   * @param {string} requester
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  private firewallCheck(requester: string, remoteAddr: string): boolean {
    // x-forward coulkd be spoofed for now lets not support
    return this.neighbourhood.checkFirewall(remoteAddr, requester)
  }
}
