import { IActiveHttpResponse } from "@activeledger/httpd/lib/httpd";
export declare class SSE {
    private res;
    private heartBeat;
    private disconnectCallback?;
    constructor(res: IActiveHttpResponse);
    onDisconnect(callback: () => void): void;
    write(sequence: number | string, prepare: unknown): boolean;
}
//# sourceMappingURL=sse.d.ts.map