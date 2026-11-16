/**
 * Helpers for the message channel between the host and its worker processes.
 *
 * With `ipcSerialization: "advanced"` messages travel by V8's structured clone
 * instead of JSON. Structured clone refuses what JSON quietly drops (a
 * function on an object, for one), so a message that cannot be cloned is sent
 * the way JSON would have sent it: what cannot travel is left behind.
 */

/** Did this send fail because the message cannot be cloned? */
export const isCloneError = (error: unknown): boolean =>
  !!error &&
  ((error as any).name === "DataCloneError" ||
    /could not be cloned/.test(String((error as any).message)));

/** The message as JSON would have carried it */
export const jsonCopy = <T>(message: T): T => JSON.parse(JSON.stringify(message));

/**
 * Wrap a child's send so a message that cannot be cloned goes as JSON would
 * have sent it. Anything else that goes wrong is left to the caller.
 */
export const withJsonFallback = (child: { send: (...a: any[]) => any }): void => {
  const raw = child.send.bind(child);
  child.send = (message: any, ...rest: any[]) => {
    try {
      return raw(message, ...rest);
    } catch (error) {
      if (!isCloneError(error)) throw error;
      return raw(jsonCopy(message), ...rest);
    }
  };
};
