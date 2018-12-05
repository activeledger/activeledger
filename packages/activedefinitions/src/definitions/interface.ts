export interface INeighbourBase {
  reference: string;
  knock(endpoint: string, params?: any, external?: boolean): Promise<any>;
}
