import { IActiveHttpResponse } from "@activeledger/httpd/lib/httpd";
export declare class HeartBeat {
    static Start(response: IActiveHttpResponse): NodeJS.Timeout;
    static Stop(interval: NodeJS.Timeout): void;
}
//# sourceMappingURL=heartbeat.d.ts.map