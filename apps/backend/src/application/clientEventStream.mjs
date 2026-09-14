import { deviceError } from "./clientDeviceAuthority.mjs";

/** Notification-only v1 stream. Every connection starts with authoritative resync.
 * Never forwards raw Provider payloads. Reconnect always repairs, not suffix replay.
 */
export class ClientEventStream {
  constructor({ coalesceMs = 500, heartbeatMs = 10000 } = {}) {
    this.clients = new Set();
    this.coalesceMs = coalesceMs;
    this.heartbeatMs = heartbeatMs;
    this.sequence = 0;
    this.inventory = false;
    this.control = false;
    this.sessions = new Set();
    this.allSessions = false;
  }
  invalidate({ inventory = false, control = false, sessionId = null } = {}) {
    if (!this.clients.size) return;
    this.inventory ||= inventory;
    this.control ||= control;
    if (sessionId) this.sessions.add(sessionId);
    if (this.sessions.size > 128) { this.sessions.clear(); this.allSessions = true; }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
      this.timer.unref?.();
    }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    const payload = { schemaVersion: 1, inventory: this.inventory, control: this.control, sessions: [...this.sessions], allSessions: this.allSessions };
    this.inventory = false; this.sessions.clear(); this.allSessions = false;
    this.control = false;
    for (const client of this.clients) client.write("invalidate", payload);
  }
  attach(response, authenticate) {
    const identity = authenticate();
    if (!identity.permissions.some(p => ["inventory.read", "messages.read", "control.read"].includes(p))) throw deviceError("DEVICE_PERMISSION_REQUIRED", 403);
    if (this.clients.size >= 16 || [...this.clients].filter(c => c.deviceId === identity.deviceId).length >= 2) throw deviceError("STREAM_LIMIT", 429);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    response.flushHeaders?.();
    const close = () => { clearInterval(heartbeat); this.clients.delete(client); if (!response.destroyed) response.destroy(); };
    const client = { deviceId: identity.deviceId, close, write: (event, payload) => {
      try {
        const current = authenticate();
        if (!current.permissions.some(p => ["inventory.read", "messages.read", "control.read"].includes(p))) return close();
        const safe = { ...payload, inventory: payload.inventory && current.permissions.includes("inventory.read"),
          control: Boolean(payload.control) && current.permissions.includes("control.read"),
          sessions: current.permissions.includes("messages.read") ? payload.sessions : [],
          allSessions: payload.allSessions && current.permissions.includes("messages.read") };
        if (response.writableLength > 65536 || !response.write(`id: ${++this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(safe)}\n\n`)) close();
      } catch { close(); }
    } };
    const heartbeat = setInterval(() => client.write("heartbeat", { schemaVersion: 1, inventory: false, sessions: [], allSessions: false }), this.heartbeatMs);
    heartbeat.unref?.();
    this.clients.add(client);
    response.once("close", close);
    client.write("reset", { schemaVersion: 1, inventory: true, control: true, sessions: [], allSessions: true });
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    for (const client of [...this.clients]) client.close();
  }
}
