export interface IChange {
  doc: IChangeDocument;
}

export interface IChangeDocument {
  _id: string;
  _rev?: string;
  processed: boolean;
  processedAt: Date;
  code: number;
  transaction: IChangeDocumentTransaction;
  umid: string;
  error: Error;
  status: number;
  message: string;
  docId: string;
  $activeledger: {};
}

interface IRevisionData {
  $i: {};
  $o: {};
}

interface ITransactionData {
  $r: {};
}

interface IChangeDocumentTransaction {
  $nodes: INodesData;
  $broadcast: boolean;
  $revs: IRevisionData;
  $tx: ITransactionData;
}

interface INodesData {
  [node: string]: INodeData;
}

interface INodeData {
  vote: boolean;
}

interface IResponseStreamData {
  new: string[];
  updated: string[];
}

export interface IResponse {
  error: Error;
  streams: IResponseStreamData;
}
