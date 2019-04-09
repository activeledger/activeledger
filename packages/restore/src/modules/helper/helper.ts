import { ActiveLogger } from "@activeledger/activelogger";
import { Provider } from "../provider/provider";

export class Helper {
  public static verbose: boolean = false;

  public static output(message: string, other?: any) {
    if (Helper.verbose) {
      other ? ActiveLogger.info(other, message) : ActiveLogger.info(message);
    }
  }

  public static getNeighbourCount = (dontIncludeSelf: boolean) =>
    dontIncludeSelf ? Provider.neighbourCount - 1 : Provider.neighbourCount;

  // Has the transaction met consensus
  public static metConsensus = (
    votes: number,
    dontIncludeSelf: boolean = false
  ) =>
    (votes / Helper.getNeighbourCount(dontIncludeSelf)) * 100 >=
    Provider.consensusReachedAmount
      ? true
      : false;
}
