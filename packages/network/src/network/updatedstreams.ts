/**
 * The ids of the streams a node's own commit reported as updated, or undefined
 * when its response does not say. Undefined means "ask": it must never be read
 * as "none" on the strength of a missing field alone, because a node that was
 * behind and is catching up through an ordinary commit can reply without
 * streams too, and the history repair exists for exactly that node.
 *
 * One reply does say none: a commit that completed (commit: true, no error)
 * without ever reaching the step that writes streams, which is what a contract that writes
 * nothing (a check, a lookup) does. There is no chain to repair after it.
 */
export function reportedUpdatedStreams(response: any): string[] | undefined {
  const updated = response?.streams?.updated;
  if (Array.isArray(updated)) {
    return updated.map((s: { id?: string }) => s?.id as string).filter(Boolean);
  }
  if (response && response.commit === true && !response.error && response.streams === undefined) {
    return [];
  }
  return undefined;
}
