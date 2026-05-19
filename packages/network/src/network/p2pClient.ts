import * as net from "net";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";
import { ActiveFrame } from "@activeledger/activeutilities";

export class P2PClient extends EventEmitter {
  private socket?: net.Socket;
  private isConnected: boolean = false;
  private hasEverConnected: boolean = false;
  private startTime: number = Date.now();
  private chunks: Buffer[] = [];
  private bufferLength: number = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private host: string, private port: number) {
    super();
  }

  public get ready(): boolean {
    return this.isConnected;
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
    
    // Grace period check: 10 minutes
    const gracePeriodPassed = (Date.now() - this.startTime) > (10 * 60 * 1000);
    if (gracePeriodPassed && !this.hasEverConnected) {
      ActiveLogger.warn(`P2P grace period expired for ${this.host}:${this.port}, disabling P2P.`);
      return;
    }

    this.socket = net.createConnection(this.port, this.host);
    this.socket.on("connect", () => {
      this.isConnected = true;
      this.hasEverConnected = true;
      ActiveLogger.info(`Connected to peer at ${this.host}:${this.port}`);
    });
    
    this.chunks = [];
    this.bufferLength = 0;

    this.socket.on("data", (data: Buffer) => {
      // ... same as before
      this.chunks.push(data);
      this.bufferLength += data.length;

      // Process all complete frames
      let frame = ActiveFrame.read(this.chunks, this.bufferLength);
      while (frame) {
        this.emit("message", frame.item);
        
        // Clean up consumed data
        this.chunks = frame.remaining.length > 0 ? [frame.remaining] : [];
        this.bufferLength = frame.remaining.length;
        
        frame = ActiveFrame.read(this.chunks, this.bufferLength);
      }
    });
    this.socket.on("close", () => {
      this.isConnected = false;
      ActiveLogger.warn(`Connection lost to ${this.host}:${this.port}, reconnecting...`);
      
      // Determine retry behavior based on history
      if (this.hasEverConnected || (Date.now() - this.startTime) <= (10 * 60 * 1000)) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        this.reconnectTimer.unref();
      } else {
        ActiveLogger.warn(`P2P reconnection window closed for ${this.host}:${this.port}`);
      }
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
