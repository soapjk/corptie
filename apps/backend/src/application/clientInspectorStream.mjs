import { createHash } from "node:crypto";
import { clientSafeJSONStringify } from "../utils/unicodeText.mjs";
import { deviceError } from "./clientDeviceAuthority.mjs";

/** A separate, visible-only Detail projection; never reloads the conversation. */
export class ClientInspectorStream {
  constructor({ snapshot, coalesceMs = 250, heartbeatMs = 10000, eventPrefix = "inspector",
    sessionScopedLimit = false, maxFrameBytes = 2 * 1024 * 1024, eventForSnapshot = null }) {
    Object.assign(this, { snapshot, coalesceMs, heartbeatMs, eventPrefix, sessionScopedLimit, maxFrameBytes, eventForSnapshot });
    this.clients = new Set();
  }
  attach(response, authenticate, sessionId, request = null, options = {}) {
    // Trusted host injection only; never selected by request/body fields.
    const snapshot = options.snapshot ?? this.snapshot;
    if (typeof snapshot !== "function") throw deviceError("INVALID_INSPECTOR_SNAPSHOT", 400);
    const identity = authenticate();
    const principalId = identity.principalId ?? identity.deviceId;
    if (!principalId) throw deviceError("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
    for (const client of [...this.clients]) {
      if (client.closed || client.response.destroyed) client.close();
    }
    if (this.clients.size >= 8 || [...this.clients].some(c => c.principalId === principalId &&
        (!this.sessionScopedLimit || c.sessionId === sessionId))) {
      throw deviceError("INSPECTOR_STREAM_LIMIT", 429);
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no" });
    response.flushHeaders?.();
    const client = { sessionId, principalId, authenticate, response, dirty: true, busy: false, closed: false,
      snapshot,
      eventForSnapshot: options.eventForSnapshot ?? this.eventForSnapshot };
    client.close = () => {
      client.closed = true; clearInterval(client.heartbeat); clearTimeout(client.timer);
      this.clients.delete(client); if (!response.destroyed) response.destroy();
    };
    response.once("close", client.close);
    request?.once("close", client.close);
    client.heartbeat = setInterval(() => {
      try { client.authenticate(); } catch { client.close(); return; }
      if (!client.busy && !response.writableNeedDrain) this.write(client, "heartbeat", {});
    }, this.heartbeatMs);
    client.heartbeat.unref?.();
    this.clients.add(client);
    void this.deliver(client);
  }
  write(client, event, value) {
    if (client.closed) return;
    try {
      client.authenticate();
      const frame = `event: ${event}\ndata: ${clientSafeJSONStringify(value)}\n\n`;
      if (Buffer.byteLength(frame) + client.response.writableLength > this.maxFrameBytes) {
        client.close(); return;
      }
      // Honor backpressure: no second snapshot is prepared until drain/close.
      const wrote = client.response.write(frame);
      client.response.flush?.();
      return wrote;
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
      const value = await client.snapshot.call(this, identity, client.sessionId);
      if (client.closed) return;
      // Projection may await I/O. Revalidate before event generation as well
      // as write, so revoked results cannot affect a service journal/baseline.
      client.authenticate();
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      if (hash !== client.hash) {
        const event = client.eventForSnapshot?.(client.previous, value) ?? { name: `${this.eventPrefix}-snapshot`, value };
        const wrote = this.write(client, event.name, event.value);
        if (client.closed || typeof wrote !== "boolean") return;
        client.previous = value;
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
      this.write(client, `${this.eventPrefix}-error`, { code: error.code ?? "INSPECTOR_READ_FAILED", status: String(status) });
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
