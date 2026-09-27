import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

/** A separate, visible-only Detail projection; never reloads the conversation. */
export class ClientInspectorStream {
  constructor({ snapshot, coalesceMs = 250, heartbeatMs = 10000 }) {
    Object.assign(this, { snapshot, coalesceMs, heartbeatMs });
    this.clients = new Set();
  }
  attach(response, authenticate, sessionId) {
    const identity = authenticate();
    if (this.clients.size >= 8 || [...this.clients].some(c => c.deviceId === identity.deviceId)) {
      throw deviceError("INSPECTOR_STREAM_LIMIT", 429);
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    response.flushHeaders?.();
    const client = { sessionId, deviceId: identity.deviceId, authenticate, response, dirty: true, busy: false, closed: false };
    client.close = () => {
      client.closed = true; clearInterval(client.heartbeat); clearTimeout(client.timer);
      this.clients.delete(client); if (!response.destroyed) response.destroy();
    };
    response.once("close", client.close);
    client.heartbeat = setInterval(() => this.write(client, "heartbeat", {}), this.heartbeatMs);
    client.heartbeat.unref?.();
    this.clients.add(client);
    void this.deliver(client);
  }
  write(client, event, value) {
    if (client.closed) return;
    try {
      client.authenticate();
      const frame = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
      if (Buffer.byteLength(frame) > 2 * 1024 * 1024 || client.response.writableLength > 2 * 1024 * 1024) {
        client.close(); return;
      }
      // Honor backpressure: no second snapshot is prepared until drain/close.
      return client.response.write(frame);
    } catch { client.close(); }
  }
  invalidate() {
    for (const client of this.clients) {
      client.dirty = true;
      if (client.busy || client.timer) continue;
      client.timer = setTimeout(() => { client.timer = null; void this.deliver(client); }, this.coalesceMs);
      client.timer.unref?.();
    }
  }
  async deliver(client) {
    if (client.closed || client.busy) return;
    client.busy = true; client.dirty = false;
    try {
      const identity = client.authenticate();
      const value = await this.snapshot(identity, client.sessionId);
      if (client.closed) return;
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      if (hash !== client.hash) {
        const wrote = this.write(client, "inspector-snapshot", value);
        client.hash = hash;
        if (wrote === false && !client.closed && client.response.writableNeedDrain) {
          await new Promise(resolve => {
            const finish = () => { client.response.off("drain", finish); client.response.off("close", finish); resolve(); };
            client.response.once("drain", finish); client.response.once("close", finish);
          });
        }
      }
    } catch (error) {
      const status = error.statusCode ?? error.status ?? 503;
      this.write(client, "inspector-error", { code: error.code ?? "INSPECTOR_READ_FAILED", status: String(status) });
      if ([401, 403, 404].includes(status)) client.close();
    } finally {
      client.busy = false;
      if (client.dirty && !client.closed && !client.timer) {
        client.timer = setTimeout(() => { client.timer = null; void this.deliver(client); }, this.coalesceMs);
        client.timer.unref?.();
      }
    }
  }
}
