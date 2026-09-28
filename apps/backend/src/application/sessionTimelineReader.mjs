import { TimelineReadPool } from "../store/timelineReadPool.mjs";
import { storedSessionDetail } from "./storedSessionDetail.mjs";
import { DEFAULT_SESSION_HISTORY_WINDOW } from "./sessionHistoryWindow.mjs";
import { preferredSessionCwd, preferredSessionTitle } from "../utils/sessionPresentation.mjs";

// Owns the lazy read pool and all materialized timeline reads. Closing detaches
// the pool before awaiting workers, so data-root recovery can create a fresh one.
export function createSessionTimelineReader({
  store, requireSessionReference, decorateSessionForClient,
  createReadPool = (options) => new TimelineReadPool(options)
}) {
  let timelineReadPool = null;

  function getTimelineReadPool() {
    if (timelineReadPool) return timelineReadPool;
    timelineReadPool = createReadPool({
      dbPath: store.dbPath,
      configPath: store.configPath,
      dataRoot: store.dataRoot,
      size: Number(process.env.CORPTIE_TIMELINE_READ_CONCURRENCY) || 4
    });
    return timelineReadPool;
  }

  async function closeTimelineReadPool() {
    const closing = timelineReadPool;
    timelineReadPool = null;
    await closing?.close();
  }

  async function getStoredSessionSnapshot(sessionId) {
    const reference = requireSessionReference(sessionId);
    const summary = reference.metadata.session;
    const stored = store.getDetail(reference.sessionId, { includeItems: false }) ?? {};
    const provider = summary.external?.provider ?? stored.source ?? "";
    const timelineRead = await getTimelineReadPool().readStoredTimelineSnapshot({
      sessionId: reference.sessionId,
      limit: DEFAULT_SESSION_HISTORY_WINDOW,
      provider
    });
    const timelineWindow = timelineRead.window;
    const detail = decorateSessionForClient({
      ...stored,
      ...summary,
      id: reference.sessionId,
      title: preferredSessionTitle(summary, stored),
      status: summary.status,
      activityStatus: summary.activityStatus ?? null,
      cwd: preferredSessionCwd(summary, stored),
      source: summary.external?.provider ?? stored.source ?? null,
      connectionStatus: summary.external?.connectionStatus ?? stored.connectionStatus ?? null,
      canSend: summary.capabilities?.canSend ?? stored.canSend ?? false,
      capabilities: summary.capabilities ?? stored.capabilities,
      items: timelineWindow.items
    });
    // session_items is the materialized product Timeline. Snapshot reads never
    // scan queues, collaboration state, automation events, or Provider state to
    // repair it. Those domains project into session_items when they mutate.
    return {
      ...detail,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      publicSessionId: reference.logicalSessionId ?? reference.sessionId,
      hasMoreHistory: timelineWindow.hasEarlier,
      historyItemsCount: timelineWindow.historyItemsCount,
      lastEventSequence: timelineRead.lastEventSequence,
      lastAgentMessageSequence: timelineRead.lastAgentMessageSequence,
      timelineRevision: timelineRead.timelineRevision
    };
  }

  // Timeline history is a pure keyset read over Corptie's materialized
  // session_items authority. It never scans Provider history or reconstructs
  // supplementary cards during a GET.
  async function readSessionHistory(sessionId, beforeId, limit) {
    const reference = requireSessionReference(sessionId);
    const provider = reference.metadata?.session?.external?.provider ?? "";
    const page = await getTimelineReadPool().readTimelineHistoryPage({
      sessionId: reference.sessionId,
      beforeId,
      limit,
      provider
    });
    return {
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      ...page
    };
  }

  async function readSessionTimelineWindow(sessionId, options) {
    const reference = requireSessionReference(sessionId);
    const provider = reference.metadata?.session?.external?.provider ?? "";
    const timelineRead = await getTimelineReadPool().readTimelineWindow({
      sessionId: reference.sessionId,
      ...options,
      provider
    });
    const storedWindow = timelineRead.window;
    if (storedWindow) {
      return {
        protocolVersion: 2,
        revision: timelineRead.timelineRevision,
        sessionId: reference.sessionId,
        logicalSessionId: reference.logicalSessionId,
        ...storedWindow,
        anchor: options.anchorId
          ? {
            kind: options.anchorKind,
            requestedId: options.anchorId,
            resolvedId: options.anchorId,
            status: "found"
          }
          : { kind: "latest", requestedId: null, resolvedId: storedWindow.items.at(-1)?.id ?? null, status: "latest" }
      };
    }
    const window = {
      items: [],
      hasEarlier: false,
      hasLater: false,
      anchor: {
        kind: options.anchorKind === "turn" ? "turn" : "item",
        requestedId: options.anchorId ?? null,
        resolvedId: null,
        status: "missing"
      }
    };
    return {
      protocolVersion: 2,
      revision: timelineRead.timelineRevision,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      ...window
    };
  }

  async function readStoredSessionDetail(reference) {
    const summary = reference.metadata?.session ?? store.getSession(reference.sessionId);
    if (!summary) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    return storedSessionDetail({
      summary,
      storedDetail: store.getDetail(reference.sessionId)
    });
  }

  return {
    getTimelineReadPool, closeTimelineReadPool, getStoredSessionSnapshot,
    readSessionHistory, readSessionTimelineWindow, readStoredSessionDetail
  };
}
