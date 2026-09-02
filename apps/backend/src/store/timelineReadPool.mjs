import os from "node:os";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const DEFAULT_POOL_SIZE = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));

export class TimelineReadPool {
  constructor(options) {
    if (!options?.dbPath) throw new Error("Timeline read pool requires a database path.");
    this.options = options;
    this.size = Math.max(1, Math.min(16, Number(options.size) || DEFAULT_POOL_SIZE));
    this.maxQueueDepth = Math.max(this.size, Number(options.maxQueueDepth) || 512);
    this.workerURL = options.workerURL ?? new URL("./timelineReadWorker.mjs", import.meta.url);
    this.slots = [];
    this.queue = [];
    this.inFlightByKey = new Map();
    this.closing = false;
    for (let index = 0; index < this.size; index += 1) this.#spawn(index);
  }

  readStoredTimelineSnapshot(input) {
    return this.#singleFlight("storedTimelineSnapshot", input);
  }

  readTimelineHistoryPage(input) {
    return this.#enqueue("timelineHistoryPage", input);
  }

  readTimelineWindow(input) {
    return this.#singleFlight("timelineWindow", input);
  }

  readTimelineChanges(input) {
    return this.#singleFlight("timelineChanges", input);
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    const error = timelineReadError("Timeline read pool is closing.", "TIMELINE_READ_POOL_CLOSED", 503);
    for (const request of this.queue.splice(0)) request.reject(error);
    for (const slot of this.slots) {
      if (slot.request) slot.request.reject(error);
      slot.request = null;
    }
    this.inFlightByKey.clear();
    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()));
    this.slots = [];
  }

  #singleFlight(operation, input) {
    const key = `${operation}:${stableInputKey(input)}`;
    const existing = this.inFlightByKey.get(key);
    if (existing) return existing;
    const request = this.#enqueue(operation, input);
    this.inFlightByKey.set(key, request);
    request.finally(() => {
      if (this.inFlightByKey.get(key) === request) this.inFlightByKey.delete(key);
    }).catch(() => {});
    return request;
  }

  #enqueue(operation, input) {
    if (this.closing) {
      return Promise.reject(timelineReadError(
        "Timeline read pool is unavailable.",
        "TIMELINE_READ_POOL_CLOSED",
        503
      ));
    }
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(timelineReadError(
        "Timeline read queue is full; retry after current history reads finish.",
        "TIMELINE_READ_OVERLOADED",
        503
      ));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestId: `timeline-read:${randomUUID()}`,
        operation,
        input,
        resolve,
        reject
      });
      this.#drain();
    });
  }

  #spawn(index, restartCount = 0) {
    if (this.closing) return;
    const worker = new Worker(this.workerURL, {
      workerData: {
        dbPath: this.options.dbPath,
        configPath: this.options.configPath,
        dataRoot: this.options.dataRoot,
        readCacheSizeKiB: this.options.readCacheSizeKiB ?? 65_536,
        readMmapSizeBytes: this.options.readMmapSizeBytes ?? 268_435_456
      }
    });
    const slot = { index, worker, ready: false, request: null, restartCount };
    this.slots[index] = slot;
    worker.on("message", (message) => this.#onMessage(slot, message));
    worker.on("error", (error) => this.#retire(slot, error));
    worker.on("exit", (code) => {
      if (!this.closing && this.slots[index] === slot) {
        this.#retire(slot, timelineReadError(
          `Timeline read Worker exited with code ${code}.`,
          "TIMELINE_READ_WORKER_EXITED",
          503
        ));
      }
    });
  }

  #onMessage(slot, message) {
    if (this.slots[slot.index] !== slot) return;
    if (message?.type === "ready") {
      slot.ready = true;
      slot.restartCount = 0;
      this.#drain();
      return;
    }
    if (message?.type === "fatal") {
      const error = errorFromMessage(message.error, "Timeline read Worker failed to initialize.");
      for (const request of this.queue.splice(0)) request.reject(error);
      this.#retire(slot, error, false);
      return;
    }
    if (message?.type !== "result" || message.requestId !== slot.request?.requestId) return;
    const request = slot.request;
    slot.request = null;
    if (message.error) request.reject(errorFromMessage(message.error, "Timeline read failed."));
    else {
      try {
        request.resolve(JSON.parse(new TextDecoder().decode(message.payload)));
      } catch (error) {
        request.reject(timelineReadError(
          `Timeline read Worker returned an invalid payload: ${error.message}`,
          "TIMELINE_READ_PAYLOAD_INVALID",
          500
        ));
      }
    }
    this.#drain();
  }

  #retire(slot, error, respawn = true) {
    if (this.slots[slot.index] !== slot) return;
    this.slots[slot.index] = null;
    if (slot.request) slot.request.reject(error);
    slot.request = null;
    void slot.worker.terminate().catch(() => {});
    if (!this.closing && respawn && slot.restartCount < 2) {
      this.#spawn(slot.index, slot.restartCount + 1);
      return;
    }
    if (!this.closing && respawn) {
      const unavailable = timelineReadError(
        `Timeline read Worker repeatedly failed: ${error.message}`,
        "TIMELINE_READ_WORKER_UNAVAILABLE",
        503
      );
      for (const request of this.queue.splice(0)) request.reject(unavailable);
    }
  }

  #drain() {
    if (this.closing || this.queue.length === 0) return;
    for (const slot of this.slots) {
      if (!slot?.ready || slot.request || this.queue.length === 0) continue;
      const request = this.queue.shift();
      slot.request = request;
      slot.worker.postMessage({
        requestId: request.requestId,
        operation: request.operation,
        input: request.input
      });
    }
  }
}

function stableInputKey(input) {
  return JSON.stringify(Object.keys(input ?? {}).sort().map((key) => [key, input[key]]));
}

function errorFromMessage(serialized, fallback) {
  const error = timelineReadError(
    serialized?.message ?? fallback,
    serialized?.code ?? "TIMELINE_READ_FAILED",
    serialized?.statusCode ?? 500
  );
  error.name = serialized?.name ?? "Error";
  if (serialized?.stack) error.stack = serialized.stack;
  return error;
}

function timelineReadError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
