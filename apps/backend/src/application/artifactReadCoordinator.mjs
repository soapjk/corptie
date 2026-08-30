import { createHash } from "node:crypto";
import { artifactError } from "./artifactAuthorization.mjs";

export const ARTIFACT_READ_DEFAULT_LIMITS = Object.freeze({
  defaultPageBytes: 16_384,
  maxPageBytes: 65_536,
  maxUniqueBytesPerTurn: 131_072,
  maxUniquePagesPerTurn: 16,
  maxCachePages: 256,
  maxCacheBytes: 16 * 1_024 * 1_024,
  completedTurnTtlMs: 5 * 60 * 1_000
});

export class ArtifactReadCoordinator {
  constructor(options = {}) {
    if (!options.store) throw new TypeError("ArtifactReadCoordinator requires a store.");
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.now = options.now ?? Date.now;
    this.limits = Object.freeze({ ...ARTIFACT_READ_DEFAULT_LIMITS, ...(options.limits ?? {}) });
    this.pages = new Map();
    this.turns = new Map();
    this.cachedBytes = 0;
  }

  async read(input = {}) {
    const pageKey = artifactPageKey(input);
    const readReceiptId = artifactReadReceiptId(pageKey);
    throwIfAborted(input.signal);
    const existing = this.pages.get(pageKey);
    if (existing) {
      existing.lastAccessedAt = this.now();
      await input.reauthorize();
      const value = await withAbort(existing.promise, input.signal);
      const authorization = await input.reauthorize();
      return { ...value, authorization, deduplicated: true };
    }
    this.#prune();
    const durableReceipt = this.store.getArtifactReadReceipt?.(readReceiptId) ?? null;
    if (durableReceipt) {
      const entry = { lastAccessedAt: this.now(), byteLength: 0, settled: false, promise: null };
      entry.promise = this.#replayDurable(input, durableReceipt, entry).catch((error) => {
        this.pages.delete(pageKey);
        throw error;
      });
      this.pages.set(pageKey, entry);
      this.#touchTurn(input);
      return entry.promise;
    }
    const anticipatedBytes = Math.max(0, input.anticipatedBytes);
    const reservation = this.store.reserveArtifactTurnRead({
      logicalSessionId: input.logicalSessionId,
      providerBindingId: input.providerBindingId,
      turnExecutionId: input.turnExecutionId,
      byteLength: anticipatedBytes,
      uniqueBytesLimit: this.limits.maxUniqueBytesPerTurn,
      uniquePagesLimit: this.limits.maxUniquePagesPerTurn,
      updatedAt: this.clock()
    });
    if (!reservation) {
      throw artifactError(
        "ARTIFACT_TURN_READ_BUDGET_EXCEEDED",
        "Artifact read exceeds this Turn's unique page or raw-byte budget.",
        429,
        { uniqueBytesLimit: this.limits.maxUniqueBytesPerTurn, uniquePagesLimit: this.limits.maxUniquePagesPerTurn }
      );
    }
    this.#touchTurn(input);
    const entry = { lastAccessedAt: this.now(), byteLength: 0, settled: false, promise: null };
    entry.promise = this.#load(input, readReceiptId, anticipatedBytes, reservation, entry).catch((error) => {
      this.pages.delete(pageKey);
      throw error;
    });
    this.pages.set(pageKey, entry);
    return entry.promise;
  }

  finishTurn({ logicalSessionId, providerBindingId, turnExecutionId } = {}) {
    const prefix = `${logicalSessionId}\0${providerBindingId}\0${turnExecutionId}\0`;
    for (const [key, entry] of this.pages) {
      if (!key.startsWith(prefix)) continue;
      this.pages.delete(key);
      this.cachedBytes -= entry.byteLength;
    }
    this.turns.delete(`${logicalSessionId}\0${providerBindingId}\0${turnExecutionId}`);
  }

  snapshot() {
    return Object.freeze({ cachedPages: this.pages.size, cachedBytes: this.cachedBytes, activeTurns: this.turns.size });
  }

  async #load(input, readReceiptId, anticipatedBytes, reservation, entry) {
    let reservationCommitted = false;
    let reservedBytes = anticipatedBytes;
    try {
      const page = await withAbort(Promise.resolve().then(input.load), input.signal);
      const authorization = await input.reauthorize();
      throwIfAborted(input.signal);
      const unusedBytes = anticipatedBytes - page.byteLength;
      let usage = reservation;
      if (unusedBytes !== 0) {
        usage = this.store.adjustArtifactTurnReadReservation({
          logicalSessionId: input.logicalSessionId,
          providerBindingId: input.providerBindingId,
          turnExecutionId: input.turnExecutionId,
          byteDelta: -unusedBytes,
          pageDelta: 0,
          updatedAt: this.clock()
        });
        reservedBytes = page.byteLength;
      }
      const commit = () => {
        const existingReceipt = this.store.getArtifactReadReceipt?.(readReceiptId) ?? null;
        if (existingReceipt) {
          if (!receiptMatchesInput(existingReceipt, input) || existingReceipt.byteLength !== page.byteLength) {
            throw artifactError(
              "ARTIFACT_READ_RECEIPT_INVALID",
              "Durable Artifact receipt does not match the verified fixed page.",
              409
            );
          }
          usage = this.store.adjustArtifactTurnReadReservation({
            logicalSessionId: input.logicalSessionId,
            providerBindingId: input.providerBindingId,
            turnExecutionId: input.turnExecutionId,
            byteDelta: -reservedBytes,
            pageDelta: -1,
            updatedAt: this.clock()
          });
          return { receipt: existingReceipt, inserted: false };
        }
        const receipt = this.store.createArtifactReadReceipt({
          readReceiptId,
          logicalSessionId: input.logicalSessionId,
          providerBindingId: input.providerBindingId,
          turnExecutionId: input.turnExecutionId,
          artifactId: input.artifactId,
          version: input.version,
          contentHash: input.contentHash,
          byteOffset: input.offset,
          requestedLimit: input.limit,
          byteLength: page.byteLength,
          format: input.format,
          referenceId: input.referenceId,
          authorizationRevision: input.authorizationRevision,
          createdAt: this.clock()
        });
        input.recordUsage?.(receipt, page);
        return { receipt, inserted: true };
      };
      const committed = typeof this.store.runInTransaction === "function"
        ? this.store.runInTransaction(commit)
        : commit();
      reservationCommitted = true;
      entry.byteLength = page.byteLength;
      entry.settled = true;
      this.cachedBytes += page.byteLength;
      this.#enforceCacheLimit();
      return Object.freeze({
        ...page,
        authorization,
        readReceiptId: committed.receipt.readReceiptId,
        deduplicated: !committed.inserted,
        turnBudget: Object.freeze({
          uniqueBytesUsed: usage?.uniqueBytes ?? 0,
          uniqueBytesLimit: this.limits.maxUniqueBytesPerTurn,
          uniquePagesUsed: usage?.uniquePages ?? 0,
          uniquePagesLimit: this.limits.maxUniquePagesPerTurn
        })
      });
    } catch (error) {
      // Once the durable receipt exists the reservation is authoritative. A
      // secondary audit sink failure must not make the same bytes spendable a
      // second time in this Turn.
      if (!reservationCommitted) {
        this.store.adjustArtifactTurnReadReservation({
          logicalSessionId: input.logicalSessionId,
          providerBindingId: input.providerBindingId,
          turnExecutionId: input.turnExecutionId,
          byteDelta: -reservedBytes,
          pageDelta: -1,
          updatedAt: this.clock()
        });
      }
      throw error;
    }
  }

  async #replayDurable(input, receipt, entry) {
    if (!receiptMatchesInput(receipt, input)) {
      throw artifactError("ARTIFACT_READ_RECEIPT_INVALID", "Durable Artifact receipt does not match its fixed page key.", 409);
    }
    await input.reauthorize();
    const page = await withAbort(Promise.resolve().then(input.load), input.signal);
    const authorization = await input.reauthorize();
    throwIfAborted(input.signal);
    if (page.byteLength !== receipt.byteLength) {
      throw artifactError(
        "ARTIFACT_CONTENT_INTEGRITY_FAILED",
        "Durable Artifact receipt no longer matches the verified page length.",
        409
      );
    }
    entry.byteLength = page.byteLength;
    entry.settled = true;
    this.cachedBytes += page.byteLength;
    this.#enforceCacheLimit();
    const usage = this.store.getArtifactTurnReadUsage?.(
      input.logicalSessionId, input.providerBindingId, input.turnExecutionId
    );
    return Object.freeze({
      ...page,
      authorization,
      readReceiptId: receipt.readReceiptId,
      deduplicated: true,
      turnBudget: Object.freeze({
        uniqueBytesUsed: usage?.uniqueBytes ?? 0,
        uniqueBytesLimit: this.limits.maxUniqueBytesPerTurn,
        uniquePagesUsed: usage?.uniquePages ?? 0,
        uniquePagesLimit: this.limits.maxUniquePagesPerTurn
      })
    });
  }

  #touchTurn(input) {
    const turnKey = `${input.logicalSessionId}\0${input.providerBindingId}\0${input.turnExecutionId}`;
    this.turns.set(turnKey, { lastAccessedAt: this.now() });
  }

  #prune() {
    const cutoff = this.now() - this.limits.completedTurnTtlMs;
    for (const [key, entry] of this.pages) {
      if (!entry.settled || entry.lastAccessedAt >= cutoff) continue;
      this.pages.delete(key);
      this.cachedBytes -= entry.byteLength;
    }
    for (const [key, turn] of this.turns) if (turn.lastAccessedAt < cutoff) this.turns.delete(key);
  }

  #enforceCacheLimit() {
    if (this.pages.size <= this.limits.maxCachePages && this.cachedBytes <= this.limits.maxCacheBytes) return;
    const completed = [...this.pages.entries()]
      .filter(([, entry]) => entry.settled)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
    for (const [key, entry] of completed) {
      if (this.pages.size <= this.limits.maxCachePages && this.cachedBytes <= this.limits.maxCacheBytes) break;
      this.pages.delete(key);
      this.cachedBytes -= entry.byteLength;
    }
  }
}

export function artifactPageKey(input = {}) {
  return [
    input.logicalSessionId, input.providerBindingId, input.turnExecutionId,
    input.artifactId, input.version, input.contentHash,
    input.offset, input.limit, input.format
  ].join("\0");
}

function artifactReadReceiptId(pageKey) {
  return `artifact_read_receipt:${createHash("sha256").update(pageKey).digest("hex")}`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Artifact read was canceled.", { cause: signal.reason });
  error.code = "ARTIFACT_READ_CANCELED";
  error.statusCode = 499;
  throw error;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { throwIfAborted(signal); }
      catch (error) { reject(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); }
    );
  });
}

function receiptMatchesInput(receipt, input) {
  return receipt.logicalSessionId === input.logicalSessionId
    && receipt.providerBindingId === input.providerBindingId
    && receipt.turnExecutionId === input.turnExecutionId
    && receipt.artifactId === input.artifactId
    && receipt.version === input.version
    && receipt.contentHash === input.contentHash
    && receipt.byteOffset === input.offset
    && receipt.format === input.format;
}
