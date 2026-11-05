import { ActiveDefinitions } from "@activeledger/activedefinitions";

/**
 * What a finished transaction keeps in memory once its hold time is over.
 *
 * A late peer only ever needs this node's own answer (the vote, the commit
 * flag, an error, the inter-node comms and so on). The transaction itself, its
 * signatures, revisions and the other nodes' answers are not needed, so they
 * are let go and the garbage collector can have them.
 */
export interface VoteOnlyRecord {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: (response?: any) => void;
  reject: (response?: any) => void;
  pid: number;
  finished: true;
  responded: true;
  shutdown: true;
  /** Marks the record as a stub, there is no transaction behind it */
  voteOnly: true;
}

const nothing = () => undefined;

export const voteOnlyRecord = (
  umid: string,
  entry: ActiveDefinitions.LedgerEntry | undefined,
  reference: string,
  pid = 0
): VoteOnlyRecord => {
  const own = entry?.$nodes?.[reference];
  return {
    entry: {
      $umid: umid,
      $broadcast: true,
      $nodes: own ? { [reference]: own } : {},
    } as any,
    resolve: nothing,
    reject: nothing,
    pid,
    finished: true,
    responded: true,
    shutdown: true,
    voteOnly: true,
  };
};
