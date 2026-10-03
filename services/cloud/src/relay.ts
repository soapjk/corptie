import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { PrincipalResolver } from "./auth.js";
import type { CloudConfig } from "./config.js";
import type { CloudDevice, CloudDeviceService } from "./devices.js";

const RELAY_PROTOCOL_VERSION = 1;
const ROUTING_HEADER_BYTES = 17;

interface RelayPeer {
  socket: WebSocket;
  accountId: string;
  device: CloudDevice;
  alive: boolean;
  connectionIds: Set<string>;
}

interface RelayConnection {
  id: string;
  accountId: string;
  mobile: RelayPeer;
  mac: RelayPeer;
}

interface RelayHubOptions {
  server: HttpServer;
  config: CloudConfig;
  devices: CloudDeviceService;
  resolvePrincipal: PrincipalResolver;
}

export class RelayHub {
  private readonly webSockets: WebSocketServer;
  private readonly peers = new Set<RelayPeer>();
  private readonly connections = new Map<string, RelayConnection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly options: RelayHubOptions) {
    this.webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: options.config.relayMaxFrameBytes,
      perMessageDeflate: false,
      clientTracking: false
    });
    options.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.heartbeat = setInterval(() => this.heartbeatPeers(), options.config.relayHeartbeatMs);
    this.heartbeat.unref();
  }

  revokeDevice(accountId: string, deviceId: string): void {
    for (const peer of this.peers) {
      if (peer.accountId === accountId && peer.device.id === deviceId) {
        peer.socket.close(4003, "device revoked");
      }
    }
  }

  revokeAccount(accountId: string): void {
    for (const peer of this.peers) {
      if (peer.accountId === accountId) peer.socket.close(4003, "account authorization revoked");
    }
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const peer of this.peers) peer.socket.terminate();
    this.connections.clear();
    this.peers.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const host = request.headers.host ?? `${this.options.config.host}:${this.options.config.port}`;
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname !== "/v1/relay") {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) {
        rejectUpgrade(socket, 400, "deviceId is required");
        return;
      }
      const webRequest = new Request(url, { method: "GET", headers: request.headers as HeadersInit });
      const principal = await this.options.resolvePrincipal(webRequest, ["connections:write"]);
      const device = this.options.devices.getForAccount(principal.accountId, deviceId);
      if (!device || device.revokedAt) {
        rejectUpgrade(socket, 403, "Device is not active for this account");
        return;
      }
      const accountPeerCount = [...this.peers].filter((peer) => peer.accountId === principal.accountId).length;
      if (accountPeerCount >= this.options.config.relayMaxConnectionsPerAccount) {
        rejectUpgrade(socket, 429, "Account relay connection limit reached");
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptPeer(webSocket, principal.accountId, device);
      });
    } catch {
      rejectUpgrade(socket, 401, "Authentication required");
    }
  }

  private acceptPeer(socket: WebSocket, accountId: string, device: CloudDevice): void {
    const peer: RelayPeer = { socket, accountId, device, alive: true, connectionIds: new Set() };
    this.peers.add(peer);
    socket.on("pong", () => { peer.alive = true; });
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.forwardEncryptedFrame(peer, data);
        else this.handleControlMessage(peer, data.toString());
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid relay message";
        socket.close(4002, message.slice(0, 120));
      }
    });
    socket.on("close", () => this.removePeer(peer));
    socket.on("error", () => this.removePeer(peer));
    this.sendControl(peer, { type: "ready", deviceId: device.id, protocolVersion: RELAY_PROTOCOL_VERSION });
  }

  private handleControlMessage(peer: RelayPeer, serialized: string): void {
    if (Buffer.byteLength(serialized) > 4_096) throw new Error("control message too large");
    const message = JSON.parse(serialized) as { type?: unknown; targetDeviceId?: unknown; requestId?: unknown };
    if (message.type !== "connect" || typeof message.targetDeviceId !== "string") {
      throw new Error("unsupported control message");
    }
    if (peer.device.kind !== "mobile") throw new Error("only mobile devices initiate relay connections");
    const target = this.options.devices.getForAccount(peer.accountId, message.targetDeviceId);
    if (!target || target.kind !== "mac" || target.revokedAt) throw new Error("target Mac is unavailable");
    const macPeer = [...this.peers].find((candidate) =>
      candidate.accountId === peer.accountId && candidate.device.id === target.id && candidate.socket.readyState === WebSocket.OPEN
    );
    if (!macPeer) throw new Error("target Mac is offline");
    const connectionId = randomUUID();
    const connection: RelayConnection = { id: connectionId, accountId: peer.accountId, mobile: peer, mac: macPeer };
    this.connections.set(connectionId, connection);
    peer.connectionIds.add(connectionId);
    macPeer.connectionIds.add(connectionId);
    const requestId = typeof message.requestId === "string" ? message.requestId : null;
    this.sendControl(peer, {
      type: "connected",
      requestId,
      connectionId,
      peer: publicPeer(macPeer.device)
    });
    this.sendControl(macPeer, {
      type: "incoming",
      connectionId,
      peer: publicPeer(peer.device)
    });
  }

  private forwardEncryptedFrame(sender: RelayPeer, rawData: RawData): void {
    const frame = toBuffer(rawData);
    if (frame.length < ROUTING_HEADER_BYTES || frame[0] !== RELAY_PROTOCOL_VERSION) {
      throw new Error("invalid encrypted frame header");
    }
    const connectionId = bytesToUuid(frame.subarray(1, ROUTING_HEADER_BYTES));
    const connection = this.connections.get(connectionId);
    if (!connection || connection.accountId !== sender.accountId) throw new Error("unknown relay connection");
    const recipient = sender === connection.mobile ? connection.mac : sender === connection.mac ? connection.mobile : null;
    if (!recipient) throw new Error("sender is not part of relay connection");
    if (recipient.socket.readyState !== WebSocket.OPEN) throw new Error("relay peer is offline");
    if (recipient.socket.bufferedAmount + frame.length > this.options.config.relayMaxQueuedBytes) {
      this.closeConnection(connectionId, "relay backpressure limit reached");
      return;
    }
    recipient.socket.send(frame, { binary: true, compress: false });
  }

  private removePeer(peer: RelayPeer): void {
    if (!this.peers.delete(peer)) return;
    for (const connectionId of [...peer.connectionIds]) this.closeConnection(connectionId, "peer disconnected");
  }

  private closeConnection(connectionId: string, reason: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    connection.mobile.connectionIds.delete(connectionId);
    connection.mac.connectionIds.delete(connectionId);
    this.sendControl(connection.mobile, { type: "disconnected", connectionId, reason });
    this.sendControl(connection.mac, { type: "disconnected", connectionId, reason });
  }

  private sendControl(peer: RelayPeer, value: unknown): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(value), { compress: false });
  }

  private heartbeatPeers(): void {
    for (const peer of this.peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }
}

function publicPeer(device: CloudDevice) {
  return {
    id: device.id,
    kind: device.kind,
    displayName: device.displayName,
    publicKeyAlgorithm: device.publicKeyAlgorithm,
    publicKey: device.publicKey,
    authEpoch: device.authEpoch
  };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

export function uuidToBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid connection UUID");
  return Buffer.from(hex, "hex");
}

function bytesToUuid(value: Buffer): string {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
