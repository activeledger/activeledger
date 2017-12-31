import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";
import { ActiveNetwork, ActiveInterfaces } from "activenetwork";
import { ActiveLogger } from 'activelogger';
import { ActiveCrypto } from "activecrypto";

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

  // Create Master Home
  let activeHome:ActiveNetwork.Home = new ActiveNetwork.Home();

  // Manage Activeledger Process Sessions
  let activeSession:ActiveNetwork.Session = new ActiveNetwork.Session(activeHome);

  // Maintain Network Neighbourhood & Let Workers know
  let activeWatch = new ActiveNetwork.Watch(activeHome, activeSession);

  // Loop CPUs and fork
  while (cpus--) {
    activeSession.add(cluster.fork());
  }

  // Watch for worker exit / crash and restart
  cluster.on("exit", worker => {
    ActiveLogger.trace(worker, "Worker has died, Restarting");
    activeSession.add(cluster.fork());
  });
} else {
  // Create Home Host Node
  let activeHost = new ActiveNetwork.Host();
}
