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
  private corkedSocket?: net.Socket;

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
    // Disable Nagle: consensus messages are small and latency-sensitive, and
    // each is a single write. With Nagle on, a write waits ~40ms to coalesce
    // with data that never comes, so every hop paid a round of delayed-ACK
    // latency - measured at ~80ms per transaction vs ~31ms over HTTP.
    this.socket.setNoDelay(true);
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
    const socket = this.socket;
    if (socket && socket.writable) {
      // Frame: [SenderRef (40)][Length (4)][Payload], built in one allocation.
      // The ref is space padded to 40 bytes (a longer one is cut at 40), as
      // it always has been.
      const frame = Buffer.allocUnsafe(44 + data.length);
      frame.fill(0, 0, 40);
      frame.write(senderRef.padEnd(40, " "), 0, 40, "utf8");
      frame.writeUInt32BE(data.length, 40);
      data.copy(frame, 44);

      this.write(socket, frame);
    }
  }

  /**
   * Hand a frame to the socket, coalescing every frame written in the same
   * event loop turn into one flush (one syscall, one TCP segment run) rather
   * than one write per frame. The socket is corked on the first write of a
   * turn and uncorked from setImmediate(), once the other work queued in that
   * turn has had its chance to send. Writes to a corked socket are flushed in
   * order, so frame order is the call order.
   */
  private write(socket: net.Socket, frame: Buffer): void {
    if (this.corkedSocket !== socket) {
      this.corkedSocket = socket;
      socket.cork();
      setImmediate(() => {
        if (this.corkedSocket === socket) {
          this.corkedSocket = undefined;
        }
        // Uncork is a no-op for a socket that has been destroyed since
        socket.uncork();
      });
    }
    socket.write(frame);
  }
}
