interface ISecurityNamespaceData {
  std: string[];
}

interface ISecurityNamespaces {
  [namespace: string]: ISecurityNamespaceData;
}

export interface ISecurityCache {
  namespace: ISecurityNamespaces;
}

export interface IReferenceStreams {
  new: any[];
  updated: any[];
}
