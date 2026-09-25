import { deviceError } from "./clientDeviceAuthority.mjs";

/** Notification-only v1 stream. Every connection starts with authoritative resync.
 * Never forwards raw Provider payloads. Reconnect always repairs, not suffix replay.
 */
export class ClientEventStream {
  constructor({ coalesceMs = 500, heartbeatMs = 10000, stateSnapshot = null,
    controlSnapshot = null, timeline = null } = {}) {
    this.clients = new Set();
    this.coalesceMs = coalesceMs;
    this.heartbeatMs = heartbeatMs;
    this.sequence = 0;
    this.inventory = false;
    this.control = false;
    this.sessions = new Set();
    this.allSessions = false;
    this.stateSnapshot = stateSnapshot;
    this.controlSnapshot = controlSnapshot;
    this.timeline = timeline;
  }
  invalidate({ inventory = false, control = false, sessionId = null, sessionIds = null } = {}) {
    if (!this.clients.size) return;
    this.inventory ||= inventory;
    this.control ||= control;
    if (sessionId) this.sessions.add(sessionId);
    if (Array.isArray(sessionIds) || sessionIds instanceof Set) {
      for (const id of sessionIds) {
        if (typeof id === "string" && id) this.sessions.add(id);
      }
    }
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
    for (const client of this.clients) if (client.version !== 2) client.write("invalidate", payload);
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

  attachV2(response, authenticate, { sessionId = null, stateRevision = 0, timelineRevision = 0 } = {}) {
    const identity = authenticate();
    if (!identity.permissions.some(p => ["inventory.read", "messages.read", "control.read"].includes(p))) {
      throw deviceError("DEVICE_PERMISSION_REQUIRED", 403);
    }
    if (this.clients.size >= 16 || [...this.clients].filter(c => c.deviceId === identity.deviceId).length >= 2) {
      throw deviceError("STREAM_LIMIT", 429);
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    response.flushHeaders?.();
    const close = () => { clearInterval(heartbeat); this.clients.delete(client); if (!response.destroyed) response.destroy(); };
    const client = {
      version: 2,
      deviceId: identity.deviceId,
      sessionId,
      stateRevision: Number.isSafeInteger(Number(stateRevision)) ? Number(stateRevision) : 0,
      timelineRevision: Number.isSafeInteger(Number(timelineRevision)) ? Number(timelineRevision) : 0,
      tail: Promise.resolve(),
      close,
      authenticate,
      write: (event, payload) => {
        try {
          authenticate();
          const frame = `id: ${++this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          if (Buffer.byteLength(frame) > 8 * 1024 * 1024 || response.writableLength > 2 * 1024 * 1024
              || !response.write(frame)) close();
        } catch { close(); }
      }
    };
    const heartbeat = setInterval(() => client.write("heartbeat", { schemaVersion: 2 }), this.heartbeatMs);
    heartbeat.unref?.();
    this.clients.add(client);
    response.once("close", close);
    client.write("stream-ready", { schemaVersion: 2, pushPayloads: true, eventRecovery: "server-snapshot" });
    this.#enqueue(client, async () => {
      await this.#pushState(client, true);
      await this.#pushControl(client);
      if (client.sessionId) await this.#pushTimeline(client, true);
    });
  }

  publishState() {
    if (this.statePublishTimer) return;
    this.statePublishTimer = setTimeout(() => {
      this.statePublishTimer = null;
      for (const client of this.clients) if (client.version === 2) {
        this.#enqueue(client, () => this.#pushState(client, false));
      }
    }, 20);
    this.statePublishTimer.unref?.();
  }

  publishControl() {
    if (this.controlPublishTimer) return;
    this.controlPublishTimer = setTimeout(() => {
      this.controlPublishTimer = null;
      for (const client of this.clients) if (client.version === 2) {
        this.#enqueue(client, () => this.#pushControl(client));
      }
    }, 20);
    this.controlPublishTimer.unref?.();
  }

  publishTimeline(sessionIds) {
    const ids = new Set(Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
    for (const client of this.clients) if (client.version === 2 && ids.has(client.sessionId)) {
      this.#enqueue(client, () => this.#pushTimeline(client, false));
    }
  }

  publishReceipt(deviceId, receipt) {
    for (const client of this.clients) {
      if (client.version === 2 && client.deviceId === deviceId) {
        this.#enqueue(client, async () => client.write("command-receipt", receipt));
      }
    }
  }

  #enqueue(client, operation) {
    client.tail = client.tail.then(operation).catch(() => client.close());
  }

  async #pushState(client, forceSnapshot) {
    const identity = client.authenticate();
    if (!identity.permissions.includes("inventory.read") || !this.stateSnapshot) return;
    const snapshot = await this.stateSnapshot(identity, forceSnapshot ? 0 : client.stateRevision);
    if (!snapshot) return;
    client.write("state-snapshot", snapshot);
    client.stateRevision = Number(snapshot.revision ?? client.stateRevision);
  }

  async #pushControl(client) {
    const identity = client.authenticate();
    if (!identity.permissions.includes("control.read") || !this.controlSnapshot) return;
    const snapshot = await this.controlSnapshot(identity);
    if (snapshot) client.write("control-snapshot", snapshot);
  }

  async #pushTimeline(client, forceSnapshot) {
    const identity = client.authenticate();
    if (!identity.permissions.includes("messages.read") || !this.timeline || !client.sessionId) return;
    let snapshot = forceSnapshot;
    for (let page = 0; page < 16; page += 1) {
      const payload = await this.timeline(identity, client.sessionId, snapshot ? 0 : client.timelineRevision);
      if (!payload) return;
      client.write(payload.kind === "delta" ? "timeline-delta" : "timeline-snapshot", payload);
      client.timelineRevision = Number(payload.revision ?? client.timelineRevision);
      snapshot = false;
      if (payload.kind !== "delta" || payload.hasMore !== true) return;
    }
    client.close();
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.statePublishTimer); this.statePublishTimer = null;
    clearTimeout(this.controlPublishTimer); this.controlPublishTimer = null;
    for (const client of [...this.clients]) client.close();
  }
}
