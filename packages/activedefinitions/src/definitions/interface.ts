export interface INeighbourBase {
  reference: string;
  knock(): Promise<any>;
}
