export interface INeighbourBase {
  reference: string;
  knock(endpoint: string, params?: any, external?: boolean): Promise<any>;
}

export interface IActiveDSConnect {
  constructor(location: string): IActiveDSConnect;
  
}
