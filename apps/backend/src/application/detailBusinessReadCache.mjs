import { createHash } from "node:crypto";
import { DETAIL_RESOURCE_TYPES } from "./detailBusinessInvalidation.mjs";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const matches = (scope, filter) => Object.entries(filter).every(([key, value]) => scope[key] === value);
const invalidated = () => Object.assign(new Error("Detail read invalidated"), { code: "DETAIL_READ_INVALIDATED", status: 409 });

/** Bounded internal read cache. It does not define a wire envelope, pagination
 * token or component schema. First-page reads run only when explicitly asked. */
export class DetailBusinessReadCache {
  constructor(ports, { maxScopes = 64, maxBytes = 2 * 1024 * 1024, concurrency = 2, maxQueued = 32 } = {}) {
    this.ports = ports; this.maxScopes = maxScopes; this.maxBytes = maxBytes;
    this.concurrency = concurrency; this.maxQueued = maxQueued;
    this.scopes = new Map(); this.active = 0; this.queue = []; this.bytes = 0;
  }
  clear(filter = {}) {
    for (const [key, entry] of this.scopes) if (matches(entry.identity, filter)) this.remove(key);
  }
  remove(key) {
    const entry = this.scopes.get(key);
    if (!entry) return;
    entry.retired = true;
    for (const module of entry.modules.values()) this.bytes -= module.bytes;
    this.scopes.delete(key);
  }
  invalidate(change = {}) {
    const known = DETAIL_RESOURCE_TYPES.includes(change.resourceType);
    for (const entry of this.scopes.values()) {
      if (change.sessionId && ![entry.identity.sessionId, entry.resources.sessionId].includes(change.sessionId)) continue;
      if (change.taskId && entry.resources.taskId !== change.taskId) continue;
      if (change.workId && entry.resources.workId !== change.workId) continue;
      for (const [name, module] of entry.modules) if (!known || this.ports[name].dependencies.includes(change.resourceType)) {
        module.epoch++; module.dirty = true;
      }
    }
  }
  async admit() {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueued) throw Object.assign(new Error("Detail read queue full"), { code: "DETAIL_READ_BUSY" });
      await new Promise(resolve => this.queue.push(resolve));
    } else this.active++;
  }
  release() { const next = this.queue.shift(); if (next) next(); else this.active--; }
  async read(scope, name, identity, { force = true } = {}) {
    const port = this.ports[name];
    if (!port) return { state: "error", code: "DETAIL_MODULE_UNAVAILABLE" };
    const resources = { sessionId: scope.session.id, taskId: scope.task?.id ?? null, workId: scope.work?.id ?? null };
    const key = digest(identity), binding = digest(resources);
    let entry = this.scopes.get(key);
    if (entry && entry.binding !== binding) { this.remove(key); entry = null; }
    if (!entry) {
      entry = { identity, resources, binding, modules: new Map(), retired: false };
      this.scopes.set(key, entry);
      while (this.scopes.size > this.maxScopes) this.remove(this.scopes.keys().next().value);
    }
    let module = entry.modules.get(name);
    if (!module) { module = { epoch: 0, dirty: true, value: null, pending: null, bytes: 0 }; entry.modules.set(name, module); }
    if (module.pending) return module.pending;
    if (port.cacheable !== false && !force && !module.dirty && module.value) return module.value;
    const epoch = module.epoch;
    const operation = async () => {
      let value;
      try {
        await this.admit();
        try {
          if (entry.retired || module.epoch !== epoch) throw invalidated();
          const data = await port.read(scope, identity);
          value = { state: data === null || (Array.isArray(data?.items) && data.items.length === 0) ? "empty" : "ready", data };
          if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) value = { state: "error", code: "DETAIL_MODULE_TOO_LARGE" };
        } finally { this.release(); }
      } catch (error) {
        if (error.code === "DETAIL_READ_INVALIDATED") throw error;
        value = { state: "error", code: [401, 403].includes(error.status ?? error.statusCode)
          ? "DETAIL_MODULE_ACCESS_DENIED" : error.code === "DETAIL_READ_BUSY" ? error.code : "DETAIL_MODULE_READ_FAILED" };
      }
      if (entry.retired || module.epoch !== epoch) throw invalidated();
      const bytes = Buffer.byteLength(JSON.stringify(value));
      this.bytes += bytes - module.bytes;
      module.bytes = bytes; module.value = value; module.dirty = false;
      this.scopes.delete(key); this.scopes.set(key, entry);
      while (this.bytes > this.maxBytes && this.scopes.size) this.remove(this.scopes.keys().next().value);
      return value;
    };
    module.pending = operation();
    try { return await module.pending; } finally { module.pending = null; }
  }
}
