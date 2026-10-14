import { randomUUID } from "node:crypto";
import { detailV2Hash } from "./detailSyncV2.mjs";
import { deviceError } from "./clientDeviceAuthority.mjs";

/** Opaque, bounded read continuations. Only the host registers collection
 * loaders; a wire cursor cannot select a resource, profile or arbitrary port. */
export class DetailBusinessCollectionPager {
  constructor({ maximumCursors = 128, ttlMs = 300000, now = Date.now } = {}) {
    this.maximumCursors = maximumCursors; this.ttlMs = ttlMs; this.now = now;
    this.cursors = new Map(); this.active = 0;
  }
  key(scope) {
    return detailV2Hash({ authority: scope.authority, sessionId: scope.sessionId, catalog: scope.catalog,
      clientCapabilities: scope.clientCapabilities, generation: scope.generation,
      collectionName: scope.collectionName, revision: scope.revision });
  }
  prune() {
    for (const [id, entry] of this.cursors) if (!entry.pending && entry.expiresAt <= this.now()) this.cursors.delete(id);
  }
  issue(scope, continuation) {
    this.prune();
    if (continuation === null || continuation === undefined) return null;
    if (typeof continuation !== "string" || !continuation.length || continuation.length > 512) throw deviceError("DETAIL_CURSOR_INVALID", 409);
    const key = this.key(scope);
    const existing = [...this.cursors].find(([, entry]) => entry.key === key && entry.continuation === continuation && entry.expiresAt > this.now());
    if (existing) return existing[0];
    while (this.cursors.size >= this.maximumCursors) {
      const idle = [...this.cursors].find(([, entry]) => !entry.pending);
      if (!idle) throw deviceError("DETAIL_READ_BUSY", 429);
      this.cursors.delete(idle[0]);
    }
    const cursor = randomUUID();
    this.cursors.set(cursor, { key, scope: structuredClone(scope), continuation, expiresAt: this.now() + this.ttlMs });
    return cursor;
  }
  validate(scope, cursor) {
    this.prune();
    const entry = this.cursors.get(cursor);
    if (!entry || entry.expiresAt <= this.now() || entry.key !== this.key(scope)) throw deviceError("DETAIL_CURSOR_INVALID", 409);
    return entry;
  }
  revoke(cursor) { this.cursors.delete(cursor); }
  async read(scope, cursor, loader, revalidate) {
    const entry = this.validate(scope, cursor);
    revalidate();
    if (entry.pending) {
      const value = await entry.pending; revalidate(); this.validate(scope, cursor); return value;
    }
    if (this.active >= 2) throw deviceError("DETAIL_READ_BUSY", 429);
    this.active++;
    const operation = (async () => {
      const value = await loader(entry.continuation);
      revalidate(); this.validate(scope, cursor);
      if (!value || !Array.isArray(value.items) || value.items.length > 20
        || Buffer.byteLength(JSON.stringify(value)) > 65536) throw deviceError("DETAIL_PAGE_TOO_LARGE", 413);
      return value;
    })();
    entry.pending = operation;
    try { return await operation; } finally { entry.pending = null; this.active--; }
  }
  clear(filter = {}) {
    for (const [id, entry] of this.cursors) {
      const fields = { ...entry.scope.authority, ...entry.scope };
      if (Object.entries(filter).every(([key, value]) => fields[key] === value)) this.cursors.delete(id);
    }
  }
}
