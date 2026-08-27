import { LevelUpChain } from "levelup";

/**
 * Abstract interface for Activeledger storage backends.
 */
export interface IStorageDriver {
  get(key: string): Promise<Buffer>;
  getMany(keys: string[]): Promise<Buffer[]>;
  put(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  batch(): Promise<LevelUpChain<any, any>>;
  createReadStream(options: any): any;
  createValueStream(): any;
  isOpen(): boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  compactRange?(start: string, end: string): Promise<void>;
}
