import { HeartBeat } from "./heartbeat";
export class SSE {
    res;
    heartBeat;
    disconnectCallback;
    constructor(res) {
        this.res = res;
        res.cork(() => {
            res.writeHeader(`Content-type`, `text/event-stream`);
            res.writeHeader(`Connection`, `keep-alive`);
            res.writeHeader(`Cache-Control`, `no-cache`);
            res.writeHeader(`X-Accel-Buffering`, `no`);
            res.writeStatus(`200 OK`);
            res.write(":\n\n");
        });
        this.heartBeat = HeartBeat.Start(res);
        res.onAborted(() => {
            res.writable = false;
            HeartBeat.Stop(this.heartBeat);
            if (this.disconnectCallback) {
                this.disconnectCallback();
            }
        });
    }
    onDisconnect(callback) {
        this.disconnectCallback = callback;
    }
    write(sequence, prepare) {
        if (this.res.writable) {
            this.res.cork(() => {
                this.res.write(`id:${sequence}\nevent: message\ndata:${JSON.stringify(prepare)}\n\n`);
            });
            return true;
        }
        else {
            HeartBeat.Stop(this.heartBeat);
            return false;
        }
    }
}
//# sourceMappingURL=sse.js.map