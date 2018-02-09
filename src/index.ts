import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";
import * as minimist from "minimist";
import { ActiveNetwork, ActiveInterfaces } from "activenetwork";
import { ActiveLogger } from "activelogger";
import { ActiveCrypto } from "activecrypto";

// Process Arguments
// TOOD: Change solution to static class
(global as any).argv = minimist(process.argv.slice(2));

// Check for config
if (!fs.existsSync((global as any).argv.config || "./config.json"))
  throw ActiveLogger.fatal("No Config File Found (" + (global as any).argv.config || "./config.json" + ")");

// Get Config & Set as Global
// TOOD: Change solution to static class
(global as any).config = JSON.parse(fs.readFileSync((global as any).argv.config || "./config.json", "utf8"));

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
  let activeHome: ActiveNetwork.Home = new ActiveNetwork.Home();

  // Manage Activeledger Process Sessions
  let activeSession: ActiveNetwork.Session = new ActiveNetwork.Session(
    activeHome
  );

  // Maintain Network Neighbourhood & Let Workers know
  let activeWatch = new ActiveNetwork.Maintain(activeHome, activeSession);

  // Loop CPUs and fork
  while (cpus--) {
    activeSession.add(cluster.fork());
  }

  // Watch for worker exit / crash and restart
  cluster.on("exit", worker => {
    ActiveLogger.debug(worker, "Worker has died, Restarting");
    let restart = activeSession.add(cluster.fork());
    // We can restart but we need to update the workers left & right & ishome
    //worker.send({type:"neighbour",})
  });
} else {
  // Temporary Path Solution
  (global as any).__base = __dirname;
  // Create Home Host Node
  let activeHost = new ActiveNetwork.Host();
}
