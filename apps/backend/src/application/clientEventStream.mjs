import { deviceError } from "./clientDeviceAuthority.mjs";

export function parseRealtimeResumeQuery(query) {
  const raw = query.get("timelineRevisions");
  let timelineRevisions = {};
  if (raw != null) {
    if (raw.length > 32 * 1024) throw deviceError("INVALID_QUERY", 400);
    try { timelineRevisions = JSON.parse(raw); } catch { throw deviceError("INVALID_QUERY", 400); }
    if (!timelineRevisions || Array.isArray(timelineRevisions) || typeof timelineRevisions !== "object"
        || Object.keys(timelineRevisions).length > 48
        || Object.entries(timelineRevisions).some(([id, revision]) => !id || id.length > 512
          || !Number.isSafeInteger(revision) || revision < 0)) throw deviceError("INVALID_QUERY", 400);
  }
  const limit = query.get("backgroundTimelineLimit");
  const backgroundTimelineLimit = limit == null ? null : Number(limit);
  if (limit != null && (!Number.isSafeInteger(backgroundTimelineLimit) || backgroundTimelineLimit < 0
      || backgroundTimelineLimit > 48)) throw deviceError("INVALID_QUERY", 400);
  const coalescing = query.get("timelineCoalescing");
  if (coalescing != null && !["true", "false"].includes(coalescing)) throw deviceError("INVALID_QUERY", 400);
  return { timelineRevisions, backgroundTimelineLimit, timelineCoalescing: coalescing === "true" };
}

/** Notification-only v1 stream. Every connection starts with authoritative resync.
 * Never forwards raw Provider payloads. Reconnect always repairs, not suffix replay.
 */
export class ClientEventStream {
  constructor({ coalesceMs = 500, heartbeatMs = 10000, stateSnapshot = null,
    controlSnapshot = null, timeline = null, backgroundTimelineLimit = 48,
    backgroundTimelineBatchSize = 2, backgroundTimelineBatchDelayMs = 1000,
    backgroundTimelineBytesPerSecond = 128 * 1024 } = {}) {
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
    this.backgroundTimelineLimit = Math.max(0, Math.min(128, Number(backgroundTimelineLimit) || 0));
    this.backgroundTimelineBatchSize = Math.max(1, Math.min(48, Number(backgroundTimelineBatchSize) || 2));
    this.backgroundTimelineBatchDelayMs = Math.max(0, Number(backgroundTimelineBatchDelayMs) || 0);
    this.backgroundTimelineBytesPerSecond = Math.max(1, Number(backgroundTimelineBytesPerSecond) || 128 * 1024);
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
    if (this.clients.size >= 16 || [...this.clients].filter(c => c.deviceId === identity.deviceId).length >= 2) throw deviceError("STREAM_LIMIT", 429);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    response.flushHeaders?.();
    const close = () => { clearInterval(heartbeat); this.clients.delete(client); if (!response.destroyed) response.destroy(); };
    const client = { deviceId: identity.deviceId, close, write: (event, payload) => {
      try {
        authenticate();
        if (response.writableLength > 65536 || !response.write(`id: ${++this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) close();
      } catch { close(); }
    } };
    const heartbeat = setInterval(() => client.write("heartbeat", { schemaVersion: 1, inventory: false, sessions: [], allSessions: false }), this.heartbeatMs);
    heartbeat.unref?.();
    this.clients.add(client);
    response.once("close", close);
    client.write("reset", { schemaVersion: 1, inventory: true, control: true, sessions: [], allSessions: true });
  }

  attachV2(response, authenticate, { sessionId = null, stateRevision = 0, timelineRevision = 0,
    timelineRevisions = {}, backgroundTimelineLimit = null, timelineCoalescing = false } = {}) {
    const identity = authenticate();
    if (this.clients.size >= 16 || [...this.clients].filter(c => c.deviceId === identity.deviceId).length >= 2) {
      throw deviceError("STREAM_LIMIT", 429);
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    response.flushHeaders?.();
    const close = () => {
      clearInterval(heartbeat);
      clearTimeout(client.backgroundTimer);
      client.backgroundQueue = [];
      client.closed = true;
      this.clients.delete(client);
      if (!response.destroyed) response.destroy();
    };
    const client = {
      version: 2,
      closed: false,
      deviceId: identity.deviceId,
      sessionId,
      onDemandTimelines: backgroundTimelineLimit === 0,
      timelineCoalescing,
      stateRevision: Number.isSafeInteger(Number(stateRevision)) ? Number(stateRevision) : 0,
      timelineRevision: Number.isSafeInteger(Number(timelineRevision)) ? Number(timelineRevision) : 0,
      timelineRevisions: new Map([...Object.entries(timelineRevisions), ...(sessionId
        ? [[sessionId, Number.isSafeInteger(Number(timelineRevision)) ? Number(timelineRevision) : 0]] : [])]),
      timelinePublishVersions: new Map(),
      scheduledTimelineSessions: new Set(),
      backgroundQueue: [],
      backgroundTimer: null,
      writtenBytes: 0,
      tail: Promise.resolve(),
      close,
      authenticate,
      write: (event, payload) => {
        if (client.closed || response.destroyed) return true;
        try {
          authenticate();
          const frame = `id: ${++this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          if (Buffer.byteLength(frame) > 8 * 1024 * 1024 || response.writableLength > 2 * 1024 * 1024) {
            close();
            return true;
          }
          client.writtenBytes += Buffer.byteLength(frame);
          return response.write(frame);
        } catch { close(); return true; }
      },
      waitForWritable: (wrote) => {
        if (wrote || client.closed || response.destroyed || response.writableNeedDrain !== true) {
          return Promise.resolve();
        }
        return new Promise(resolve => {
          const finish = () => {
            response.removeListener("drain", finish);
            response.removeListener("close", finish);
            resolve();
          };
          response.once("drain", finish);
          response.once("close", finish);
        });
      }
    };
    const heartbeat = setInterval(() => client.write("heartbeat", { schemaVersion: 2 }), this.heartbeatMs);
    heartbeat.unref?.();
    this.clients.add(client);
    response.once("close", close);
    client.write("stream-ready", { schemaVersion: 2, pushPayloads: true,
      backgroundTimelines: true, eventRecovery: "server-snapshot" });
    this.#enqueue(client, async () => {
      const state = await this.#pushState(client, true);
      const selectedSessionIds = new Set(client.sessionId ? [client.sessionId] : []);
      if (client.sessionId) await this.#pushTimeline(client, false);
      if (client.sessionId) selectedSessionIds.add(client.sessionId);
      // Selection is warmed first, then the most recently updated resident
      // window. Every later Session change is still pushed, including Sessions
      // outside this bounded bootstrap set.
      const backgroundSessionIds = [...new Set((state?.sessions ?? [])
        .map(session => session?.id)
        .filter(sessionId => typeof sessionId === "string" && sessionId && !selectedSessionIds.has(sessionId)))]
        .slice(0, backgroundTimelineLimit ?? this.backgroundTimelineLimit);
      // Resume only resident cursors that are still in the authorized inventory.
      // New windows are bounded separately; do not resend all cached histories.
      const activeIds = new Set((state?.sessions ?? []).map(session => session.id));
      const resumeIds = [...client.timelineRevisions.keys()].filter(id => activeIds.has(id) && !selectedSessionIds.has(id));
      await this.#pushControl(client);
      // Keep inventory/selection/control usable before warming history. Only
      // one bounded batch is queued at a time, so live updates can interleave.
      client.backgroundQueue = [...new Set([...resumeIds, ...backgroundSessionIds])];
      await this.#pushBackgroundBatch(client);
    });
  }

  async #pushBackgroundBatch(client) {
    if (client.closed) return;
    const started = Date.now();
    const before = client.writtenBytes;
    const batch = client.backgroundQueue.splice(0, this.backgroundTimelineBatchSize);
    for (const sessionId of batch) {
      if (client.closed) return;
      await this.#pushTimeline(client, false, sessionId);
    }
    if (client.closed || !client.backgroundQueue.length) return;
    // Count serialized bytes rather than only Sessions: two long conversations
    // must not be followed immediately by another large batch. This is pacing
    // of bootstrap traffic, not an end-to-end bandwidth/receipt guarantee.
    const transmissionMs = (client.writtenBytes - before) * 1000 / this.backgroundTimelineBytesPerSecond;
    const delay = Math.max(this.backgroundTimelineBatchDelayMs, transmissionMs - (Date.now() - started));
    client.backgroundTimer = setTimeout(() => {
      client.backgroundTimer = null;
      if (!client.closed) this.#enqueue(client, () => this.#pushBackgroundBatch(client));
    }, delay);
    client.backgroundTimer.unref?.();
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
    for (const client of this.clients) if (client.version === 2) {
      for (const sessionId of ids) if (typeof sessionId === "string" && sessionId) {
        if (client.onDemandTimelines && sessionId !== client.sessionId && !client.timelineRevisions.has(sessionId)) continue;
        this.#scheduleTimeline(client, sessionId);
      }
    }
  }

  /** Successful latest-window reads opt Sessions into an existing stream.
   * Selection changes must not reconnect or miss updates racing the read. */
  observeTimeline(deviceId, sessionId, revision) {
    if (!sessionId || !Number.isSafeInteger(revision) || revision < 0) return;
    for (const client of this.clients) {
      if (client.version !== 2 || client.closed || client.deviceId !== deviceId || !client.onDemandTimelines) continue;
      client.sessionId = sessionId;
      client.timelineRevisions.set(sessionId, Math.max(revision, client.timelineRevisions.get(sessionId) ?? 0));
      while (client.timelineRevisions.size > 48) client.timelineRevisions.delete(client.timelineRevisions.keys().next().value);
      this.#scheduleTimeline(client, sessionId);
    }
  }

  /** Collapse a burst to one read at the newest durable revision. If another
   * change lands while that read is in flight, schedule exactly one follow-up.
   * Each client retains its own revision cursor and authorization boundary. */
  #scheduleTimeline(client, sessionId) {
    const version = (client.timelinePublishVersions.get(sessionId) ?? 0) + 1;
    client.timelinePublishVersions.set(sessionId, version);
    if (client.scheduledTimelineSessions.has(sessionId)) return;
    client.scheduledTimelineSessions.add(sessionId);
    this.#enqueue(client, async () => {
      const observedVersion = client.timelinePublishVersions.get(sessionId);
      try {
        await this.#pushTimeline(client, false, sessionId);
      } finally {
        client.scheduledTimelineSessions.delete(sessionId);
      }
      if (!client.closed && client.timelinePublishVersions.get(sessionId) !== observedVersion) {
        this.#scheduleTimeline(client, sessionId);
      }
    });
  }

  publishReceipt(deviceId, receipt) {
    for (const client of this.clients) {
      if (client.version === 2 && client.deviceId === deviceId) {
        // Receipts are small, independently versioned control frames. Do not
        // queue them behind a slow history read/bootstrap operation.
        if (!client.closed) client.write("command-receipt", receipt);
      }
    }
  }

  #enqueue(client, operation) {
    client.tail = client.tail.then(() => client.closed ? undefined : operation()).catch(() => client.close());
  }

  async #pushState(client, forceSnapshot) {
    const identity = client.authenticate();
    if (!this.stateSnapshot) return null;
    const snapshot = await this.stateSnapshot(identity, forceSnapshot ? 0 : client.stateRevision);
    if (!snapshot) return null;
    const wrote = client.write("state-snapshot", snapshot);
    await client.waitForWritable(wrote);
    client.stateRevision = Number(snapshot.revision ?? client.stateRevision);
    return snapshot;
  }

  async #pushControl(client) {
    const identity = client.authenticate();
    if (!this.controlSnapshot) return;
    const snapshot = await this.controlSnapshot(identity);
    if (snapshot) {
      const wrote = client.write("control-snapshot", snapshot);
      await client.waitForWritable(wrote);
    }
  }

  async #pushTimeline(client, forceSnapshot, requestedSessionId = client.sessionId) {
    const identity = client.authenticate();
    if (!this.timeline || !requestedSessionId) return;
    const selectedTimeline = requestedSessionId === client.sessionId;
    let snapshot = forceSnapshot;
    for (let page = 0; page < 16; page += 1) {
      if (client.closed) return;
      const after = snapshot ? 0 : (client.timelineRevisions.get(requestedSessionId) ?? 0);
      let payload;
      try {
        payload = await this.timeline(identity, requestedSessionId, after, { includeDetail: selectedTimeline, coalesce: client.timelineCoalescing });
      } catch (error) {
        // A Session may be archived/deleted after the inventory read. Its
        // disappearance is not a channel or device-authorization failure.
        if (error.code !== "SESSION_NOT_AVAILABLE" || error.status !== 404) throw error;
        client.timelineRevisions.delete(requestedSessionId);
        return;
      }
      if (!payload) return;
      const wrote = client.write(payload.kind === "delta" ? "timeline-delta" : "timeline-snapshot", payload);
      await client.waitForWritable(wrote);
      const revision = Number(payload.revision ?? after);
      client.timelineRevisions.set(requestedSessionId, revision);
      if (typeof payload.sessionId === "string" && payload.sessionId) {
        client.timelineRevisions.set(payload.sessionId, revision);
        if (selectedTimeline) client.sessionId = payload.sessionId;
      }
      if (selectedTimeline) client.timelineRevision = revision;
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
