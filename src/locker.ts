import { setTimeout } from "timers";

/**
 * Class manages stream locks for multiple processor safety
 * 
 * @export
 * @class Locker
 */
export class Locker {
  /**
   * Holds information about stream locks
   * In the future we can add a lock time and have a timeout to release locks
   * this shouldn't happen as V1 solves this problem however maybe useful. Alternativle on process exit
   * we can trigger release.
   *
   * Currently we do not have to concern ourselves on input and output lock differential
   *
   * @private
   * @static
   * @type {{[stream: string]: boolean}}
   * @memberof Locker
   */
  private static cell: { [stream: string]: boolean } = {};

  /**
   * Attempts to lock a stream returns is succussful
   *
   * @static
   * @param {string} stream
   * @returns {boolean}
   * @memberof Locker
   */
  public static hold(stream: string): boolean;
  public static hold(stream: string[]): boolean;
  public static hold(stream: any): boolean {
    if (Array.isArray(stream)) {
      // Are all the streams available
      let i = stream.length;
      let success = true;
      while (i--) {
        if (!Locker.hold(stream[i])) {
          // Update flag and quit early
          success = false;
          break;
        }
      }

      // If not successfull release any on hold
      setTimeout(() => {
        Locker.release(stream);
      },100);

      // Let process know
      return success;
    } else {
      // Is the single stream available?
      if (!this.cell[stream]) {
        this.cell[stream] = !this.cell[stream];
        return true;
      }
      return false;
    }
  }

  /**
   * Release stream lock
   *
   * @static
   * @param {string} stream
   * @memberof Locker
   */
  public static release(stream: string): boolean;
  public static release(stream: string[]): boolean;
  public static release(stream: any): boolean {
    if (Array.isArray(stream)) {
      let i = stream.length;
      while(i--) {
        Locker.release(stream[i]);
      }
      return true;
    }else{
      this.cell[stream] = false;
      return true;
    }
  }
}
