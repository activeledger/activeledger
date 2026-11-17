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

/**
 * The message as JSON would have carried it: a copy made by writing it as JSON
 * text and reading it back.
 *
 * Where it is used. It is the slow, safe fallback of `ipcSerialization:
 * "advanced"`, and nothing else calls it. The fast path (V8's structured
 * clone, the same engine as `ActiveClone.clone`) refuses a message that holds
 * something it cannot copy, such as a function on an object, and throws a
 * `DataCloneError`. When that happens the sender (the host in `withJsonFallback`
 * below, the worker in `Process.send`) makes this copy and sends that instead.
 * With the default `ipcSerialization: "json"` Node already sends JSON, this is
 * never reached, and the message arrives exactly as it always has.
 *
 * Why it is `JSON.parse(JSON.stringify())` and not `ActiveClone`. The point of
 * the fallback is to deliver what JSON would have: functions and keys whose
 * value is `undefined` are left out, a Date becomes its ISO text, NaN becomes
 * null. `ActiveClone.clone` is V8 serialisation and would throw on the very
 * message that sent us here; `ActiveClone.serialize` is MessagePack to a
 * compressed buffer for storage, which is not a message and keeps `undefined`.
 * Either would change what the receiver sees compared with plain JSON.
 *
 * Why speed does not matter. It runs only for a message that could not be
 * cloned, which should be rare. Anything that makes it common is worth fixing
 * at its source (the message should not carry a function) rather than by
 * making this faster.
 */
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
