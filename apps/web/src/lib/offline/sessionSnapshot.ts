import type { SessionSummary, SessionsResponse } from "../api/types";

const SNAPSHOT_KEY = "corptie:web:snapshot:sessions:v1";

type StoredSnapshot = {
  savedAt: string;
  response: SessionsResponse;
};

export function writeSessionSnapshot(response: SessionsResponse, storage: Storage = localStorage) {
  const snapshot: StoredSnapshot = {
    savedAt: new Date().toISOString(),
    response: {
      apiVersion: "1",
      eventCursor: response.eventCursor,
      sessions: response.sessions.map(sanitizeSession)
    }
  };
  try {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // A private-browsing quota error must not break the live application.
  }
}

export function readSessionSnapshot(storage: Storage = localStorage): SessionsResponse | null {
  try {
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as StoredSnapshot;
    if (snapshot.response?.apiVersion !== "1" || !Array.isArray(snapshot.response.sessions)) return null;
    return snapshot.response;
  } catch {
    return null;
  }
}

function sanitizeSession(session: SessionSummary): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    agent: session.agent,
    status: session.status,
    progress: session.progress,
    summary: "",
    activityStatus: session.activityStatus ?? null,
    updatedAt: session.updatedAt,
    accent: session.accent,
    archived: session.archived,
    pinned: session.pinned,
    avatarUrl: null,
    suggestedOptions: null,
    capabilities: null,
    availableActions: [],
    external: session.external ? {
      provider: session.external.provider,
      connectionStatus: session.external.connectionStatus ?? null,
      currentModel: session.external.currentModel ?? null,
      currentReasoningLevel: null,
      cwd: null,
      sandbox: null,
      approvalPolicy: null
    } : null
  };
}
