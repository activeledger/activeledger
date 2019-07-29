interface ISecurityNamespaceData {
  std: string[];
}

interface ISecurityNamespaces {
  [namespace: string]: ISecurityNamespaceData;
}

export interface ISecurityCache {
  namespace: ISecurityNamespaces;
  signedOutputs: boolean;
  hardenedKeys: boolean;
}

export interface IReferenceStreams {
  new: any[];
  updated: any[];
}
