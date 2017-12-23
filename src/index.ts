import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";
import { ActiveNetwork, ActiveInterfaces } from "activenetwork";
import { ActiveLogger } from "activelogger";
import { ActiveCrypto } from "activecrypto";
import { Locker } from "./locker";

// Manage Node Cluster
if (cluster.isMaster) {
  // Do we have an identity
  if (!fs.existsSync("./.identity")) {
    ActiveLogger.info("No Identity found. Generating Identity");
    let identity: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair();
    fs.writeFileSync("./.identity", JSON.stringify(identity.generate()));
    ActiveLogger.info("Identity Generated. Continue Boot Cycle");
  }

  // Launch as many nodes as cpus
  let cpus = os.cpus().length;
  ActiveLogger.info("Server is active, Creating forks " + cpus);

  // Holds worker reference
  let workers: cluster.Worker[] = new Array();

  // Loop CPUs and fork
  while (cpus--) {
    let worker = cluster.fork();

    // Add IPC listners
    worker.on("message", msg => {
      switch (msg.type) {
        case "hold":
          // Put a hold on these streams
          worker.send({ type: msg.type, lock: Locker.hold(msg.stream) });
          break;
        case "release":
          // Release these streams
          worker.send({ type: msg.type, release: Locker.release(msg.stream) });
          break;
        default:
          ActiveLogger.warn(msg, "Master -> Unknown IPC call");
          break;
      }
    });

    // Update Reference (May move to the top and do -1 trick)
    workers.push(worker);
  }

  // Watch for worker exit / crash and restart
  cluster.on("exit", worker => {
    ActiveLogger.error(worker, "Worker has died, Restarting");
    cluster.fork();
  });

  // Maintain Network Neighbourhood & Let Workers know
} else {
  // Create Home Node
  let activenode = new ActiveNetwork.Home();

  // Listen to master for Neightbour and Locker details
  process.on("message", msg => {
    switch (msg.type) {
      case "neighbour":
        // Update Routes
        ActiveNetwork.Home.left = (msg.left as ActiveNetwork.Neighbour);
        ActiveNetwork.Home.right = (msg.right as ActiveNetwork.Neighbour);
        break;
      case "hold":
        // Do we have a hold
        if(msg.lock) {
          // Yes, Continue Processing
        }else{
          // No, How to deal with it? 
        }
        break;
      case "release":
        // Did we release (Should always be yes)
        if(msg.release) {
          // Will there be anything to do?
        }
        break;
      default:
        ActiveLogger.warn(msg, "Worker -> Unknown IPC call");
        break;
    }
  });

  // Listen to the Neighbourhood
  activenode.api.listen(ActiveInterfaces.getBindingDetails("port"), () => {
    ActiveLogger.info(
      "Worker (" +
        cluster.worker.id +
        ") listening on port " +
        ActiveInterfaces.getBindingDetails("port")
    );
  });
}
