export declare const EVENT_PREFIX = "event:";
interface IAllDocs {
    allDocs(options: {
        startkey?: string;
        endkey?: string;
        include_docs?: boolean;
    }): Promise<unknown>;
}
export declare function eventsSince(db: IAllDocs, lastEventId: string): Promise<Array<[string, Record<string, unknown>]>>;
export {};
//# sourceMappingURL=events.d.ts.map