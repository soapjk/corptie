import { mapThreadItem, normalizeCodexTokenUsage } from "./codexThreadProjection.mjs";

// Ephemeral native items used by adapter commands. Persisted product timelines
// remain authoritative and are not read from this cache.
export class CodexLiveThreadCache {
  constructor({ expireTurnRequests }) {
    this.liveItemsByThread = new Map();
    this.turnDiffsByThread = new Map();
    this.tokenUsageByThread = new Map();
    this.expireTurnRequests = expireTurnRequests;
  }

  get threadCount() { return this.liveItemsByThread.size; }

  itemsForThread(threadId) {
    return Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []);
  }

  releaseThread(threadId) {
    this.liveItemsByThread.delete(threadId);
    this.turnDiffsByThread.delete(threadId);
    this.tokenUsageByThread.delete(threadId);
  }

  latestAgentMessageText(threadId, turnId) {
    const items = Array.from(this.liveItemsByThread.get(threadId)?.values() ?? []);
    const agentMessages = items.filter((item) => item.turnId === turnId && item.type === "agentMessage" && item.text);
    return agentMessages.at(-1)?.text ?? "";
  }

  attachManagedImagesToLiveItem(threadId, itemId, images) {
    const items = this.liveItemsByThread.get(threadId);
    const item = items?.get(itemId);
    if (!item || !Array.isArray(images) || images.length === 0) return false;
    let metadata = {};
    try {
      metadata = item.rawMetadataJSON ? JSON.parse(item.rawMetadataJSON) : {};
    } catch {}
    items.set(itemId, {
      ...item,
      images,
      rawMetadataJSON: JSON.stringify({ ...metadata, images })
    });
    return true;
  }

  tokenUsageForThread(threadId) {
    return this.tokenUsageByThread.get(threadId) ?? null;
  }

  captureLiveItem(message) {
    const method = message.method;
    const params = message.params ?? {};
    const threadId = params.threadId;
    const turnId = params.turnId;
    if (!threadId) {
      return;
    }

    if (method === "turn/diff/updated" && turnId && typeof params.diff === "string") {
      if (!this.turnDiffsByThread.has(threadId)) {
        this.turnDiffsByThread.set(threadId, new Map());
      }
      this.turnDiffsByThread.get(threadId).set(turnId, params.diff);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = normalizeCodexTokenUsage(params.tokenUsage ?? params.usage, params);
      if (usage) {
        this.tokenUsageByThread.set(threadId, usage);
      }
      return;
    }

    if (!this.liveItemsByThread.has(threadId)) {
      this.liveItemsByThread.set(threadId, new Map());
    }
    const items = this.liveItemsByThread.get(threadId);

    if ((method === "item/started" || method === "item/completed") && params.item) {
      // Item completion and turn completion are separate lifecycle events. An
      // agent message may finish while the turn continues with more work, so
      // never promote item/completed into a terminal turn status.
      const item = mapThreadItem({ id: turnId ?? threadId, status: "inProgress" }, {
        ...params.item,
        id: params.item.id ?? `${threadId}:${items.size}`,
        status: params.item.status ?? (method === "item/completed" ? "completed" : "inProgress")
      });
      item.turnStatus = "inProgress";
      items.set(item.id, item);
      return;
    }

    if (method === "error") {
      const error = params.error ?? {};
      // Codex emits one native error notification for each retry. Keep those
      // events in the Provider inbox, but project one stable Timeline item per
      // Turn so clients update a single card instead of appending five cards.
      const retryId = turnId && params.willRetry
        ? `${threadId}:reconnect:${turnId}` : null;
      const itemId = retryId ?? `${threadId}:error:${items.size + 1}`;
      const previous = retryId ? items.get(retryId) : null;
      const attempt = previous ? (previous.retryAttempt ?? 1) + 1 : 1;
      items.set(itemId, {
        id: itemId,
        turnId: turnId ?? threadId,
        turnStatus: params.willRetry ? "inProgress" : "failed",
        type: "error",
        title: params.willRetry ? `Codex reconnecting · retry ${attempt}` : "Codex error",
        text: [error.message, error.additionalDetails].filter(Boolean).join("\n"),
        status: params.willRetry ? "retrying" : "failed",
        ...(retryId ? {
          retryAttempt: attempt,
          rawMetadataJSON: JSON.stringify({ connectionRetry: { schemaVersion: 1, attempt } })
        } : {})
      });
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn ?? {};
      const completedTurnId = turn.id ?? turnId ?? null;
      const terminalStatus = turn.status
        ?? (turn.error ? "failed" : "completed");
      if (completedTurnId) {
        this.expireTurnRequests(threadId, completedTurnId);
        for (const [itemId, item] of items) {
          if (item.turnId !== completedTurnId) continue;
          const retrySettled = item.type === "error" && item.retryAttempt;
          items.set(itemId, {
            ...item,
            turnStatus: terminalStatus,
            ...(retrySettled ? {
              title: terminalStatus === "completed"
                ? `Codex reconnected · ${item.retryAttempt} retries`
                : `Codex reconnect failed · ${item.retryAttempt} retries`,
              status: terminalStatus === "completed" ? "completed" : "failed"
            } : {})
          });
        }
      }
      if (!turn.error) {
        return;
      }
      const index = items.size + 1;
      items.set(`${threadId}:turn-completed:${turn.id ?? index}`, {
        id: `${threadId}:turn-completed:${turn.id ?? index}`,
        turnId: completedTurnId ?? threadId,
        turnStatus: terminalStatus,
        type: "taskComplete",
        title: turn.error ? "Turn failed" : "Turn completed",
        text: turn.error?.message ?? "",
        status: terminalStatus
      });
    }
  }
}
