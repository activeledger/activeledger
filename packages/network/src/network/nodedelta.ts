/**
 * Which of a peer broadcast's per-node responses are news to a worker.
 *
 * Every peer vote that reaches the host used to be forwarded to the worker with
 * the whole $nodes map, though the worker merges it by key and most of the map
 * (and about a quarter of the messages in all) is what it was told last time. A
 * transaction remembers a signature of each response it has already forwarded;
 * only a response whose signature changed goes on, and a broadcast with none
 * is not forwarded at all. The worker merges whatever it is given into the
 * entry it already holds, so a partial map is the same as a full one.
 */

/**
 * A signature of one node's response. The scalar fields are the vote's state
 * as it moves from a placeholder to a vote to a commit; once a response carries
 * the commit data (streams, the contract's return, post processing, the time)
 * the signature is that data in full, so a response is never treated as
 * unchanged when any part of it differs.
 */
export function nodeSignature(node: any): string {
  if (!node || typeof node !== "object") return String(node);
  const head = `${node.vote}|${node.commit}|${node.early}|${node.leader}|${node.error || ""}|${node.sig || ""}`;
  if (node.streams || node.return || node.post || node.datetime) {
    return head + "|" + JSON.stringify([node.streams, node.return, node.post, node.datetime]);
  }
  return head;
}

/**
 * The responses in `nodes` that differ from what `sent` records as already
 * forwarded, or undefined if none do. Updates `sent` to match.
 */
export function changedNodes(
  nodes: { [reference: string]: any },
  sent: { [reference: string]: string }
): { [reference: string]: any } | undefined {
  let delta: { [reference: string]: any } | undefined;
  for (const reference of Object.keys(nodes)) {
    const signature = nodeSignature(nodes[reference]);
    if (sent[reference] !== signature) {
      sent[reference] = signature;
      (delta || (delta = {}))[reference] = nodes[reference];
    }
  }
  return delta;
}
