import { LevelUpChain } from "levelup";

/**
 * Abstract interface for Activeledger storage backends.
 */
export interface IStorageDriver {
  get(key: string): Promise<Buffer>;
  /** Like get(), but resolves undefined for a missing key instead of throwing (optional: a driver without it is read through get()). */
  getOrUndefined?(key: string): Promise<Buffer | undefined>;
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
