import { ActiveNetwork, ActiveInterfaces } from "activenetwork";
import { ActiveLogger } from "activelogger";
import { ActiveCrypto } from "activecrypto";
import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";

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

  while (cpus--) {
    cluster.fork();
  }

  // Watch for worker exit / crash and restart
  cluster.on("exit", worker => {
    ActiveLogger.error(worker, "Worker has died, Restarting");
    cluster.fork();
  });

  // Maintain a list of "locked" streams

  // Maintain Network Neighbourhood
} else {
  // Create Home Node
  let activenode = new ActiveNetwork.Home();

  // Listen to the Neighbourhood
  activenode.api.listen(ActiveInterfaces.getHostDetails("port"), () => {
    ActiveLogger.info(
      "Worker (" +
        cluster.worker.id +
        ") listening on port " +
        ActiveInterfaces.getHostDetails("port")
    );
  });

  // Listen to master to update neighbours

  // Check with master about locks
}
