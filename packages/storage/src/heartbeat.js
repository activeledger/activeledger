export class HeartBeat {
    static Start(response) {
        return setInterval(() => {
            if (response.writable) {
                response.cork(() => {
                    response.write(":\n\n");
                });
            }
        }, 10 * 60 * 1000);
    }
    static Stop(interval) {
        clearInterval(interval);
    }
}
//# sourceMappingURL=heartbeat.js.map