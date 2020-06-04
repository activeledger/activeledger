import RocksDB from "rocksdb";
import LevelDOWN from "leveldown";
import { LevelUp, default as levelup } from "levelup";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";

export class LevelMe {
  private levelUp: LevelUp;

  constructor(location: string) {
    this.levelUp = levelup(RocksDB(location));
  }

  public async info() {
    ActiveLogger.fatal("Not Implemented");
  }

  public close() {
    this.levelUp.close();
  }

  public async createIndex(options: unknown) {
    ActiveLogger.fatal("Not Implemented");
  }

  public async deleteIndex(options: unknown) {
    ActiveLogger.fatal("Not Implemented");
  }

  public async getIndexes() {
    ActiveLogger.fatal("Not Implemented");
    return {
      indexes: [],
    };
  }

  public async allDocs(options: unknown) {
    ActiveLogger.fatal("Not Implemented");
    return [];
  }

  public async get(key:string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

  public async post(key:string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

  public async put(key:string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

  public async del(key:string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

  public async changes(options:string) {
    ActiveLogger.fatal("Not Implemented");
    return new EventEmitter();
  }

  public async bulkDocs(docs: unknown[], options:string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

}
