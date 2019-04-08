import { ActiveLogger } from "@activeledger/activelogger";

export class Helper {
  public static verbose: boolean = false;

  public static output(message: string, other?: any) {
    if (Helper.verbose) {
      other ? ActiveLogger.info(other, message) : ActiveLogger.info(message);
    }
  }
}
