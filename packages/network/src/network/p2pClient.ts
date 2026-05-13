import * as net from "net";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";

export class P2PClient extends EventEmitter {
  private socket?: net.Socket;
  private isConnected: boolean = false;
  private buffer: Buffer = Buffer.alloc(0);
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private host: string, private port: number) {
    super();
  }

  public stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.socket) {
      this.socket.destroy();
    }
  }

  public connect(): void {
    if (this.isConnected) return;

    this.socket = net.createConnection(this.port, this.host);
    this.socket.on("connect", () => {
      this.isConnected = true;
      ActiveLogger.info(`Connected to peer at ${this.host}:${this.port}`);
    });

    this.socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      
      // Process all complete frames in the buffer
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length >= 4 + length) {
          const item = this.buffer.slice(4, 4 + length);
          this.emit("message", item);
          this.buffer = this.buffer.slice(4 + length);
        } else {
          break;
        }
      }
    });

    this.socket.on("close", () => {
      this.isConnected = false;
      ActiveLogger.warn(`Connection lost to ${this.host}:${this.port}, reconnecting...`);
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      this.reconnectTimer.unref();
    });

    this.socket.on("error", (err) => {
      ActiveLogger.error(err, `Error with peer ${this.host}:${this.port}`);
    });
  }

  public send(data: Buffer, senderRef: string): void {
    if (this.socket && this.socket.writable) {
      // Frame: [SenderRef (40)][Length (4)][Payload]
      const refBuf = Buffer.alloc(40);
      refBuf.write(senderRef.padEnd(40, ' '), 0, 'utf8');
      
      const frame = Buffer.alloc(4 + data.length);
      frame.writeUInt32BE(data.length, 0);
      data.copy(frame, 4);

      this.socket.write(Buffer.concat([refBuf, frame]));
    }
  }
}
