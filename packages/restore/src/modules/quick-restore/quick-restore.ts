import { ActiveLogger } from "@activeledger/activelogger";
import { Provider } from "../provider/provider";
import { ActiveNetwork } from "@activeledger/activenetwork";

export class QuickRestore {
  public static initialise(): void {}

  private runQuickFullRestore(): void {
    ActiveLogger.info("Starting Quick Full Restore");

    const neighbourhood = Provider.network.neighbourhood.get();
    const nodes = Object.keys(neighbourhood);

    const promises: Array<Promise<any>> = [];

    for (let i = nodes.length; i--; ) {
      const node = neighbourhood[nodes[i]];

      if (node.reference !== ActiveNetwork.Home.reference) {
        promises.push(this.asyncRecursiveRebuild(node));
      }
    }

    Promise.all(promises)
      .then((results) => {
        let expandCompare: any = {};

        let consensusReached: Array<any> = [];

        for (let i = results.length; i--; ) {
          const list = results[i].streams;
          // TODO:
        }
      })
      .catch((err: unknown) => {
        console.error(err);
      });
  }

  private asyncRecursiveRebuild(node: ActiveNetwork.Neighbour): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let output: any[] = [];
      const knockResults = await node.knock("all");

      if (knockResults.data) {
        const id = knockResults.data[knockResults.data.length - 1].id;
        output = (await node.knock(`all/${id}`)).data;
      }

      if (output) {
        resolve({ reference: node.reference, streams: output });
      } else {
        reject("No output");
      }
    });
  }
}
