import type {
  ApiV1Error,
  AttentionResponse,
  BootstrapResponse,
  SessionResponse,
  SessionsResponse
} from "./types";
import { readSessionSnapshot, writeSessionSnapshot } from "../offline/sessionSnapshot";

let csrfToken: string | null = null;
let csrfBootstrapPromise: Promise<void> | null = null;

type PairingRequestResponse = {
  requestId: string;
  exchangeToken: string;
  status: "pending";
  expiresAt: string;
};

type PairingClaimResponse = {
  status: "pending" | "approved" | "rejected";
  expiresAt: string;
  csrfToken?: string;
  device?: {
    id: string;
    name: string;
    permission: "read-only" | "reply" | "full-control";
  };
};

export class CorptieApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, payload: ApiV1Error) {
    super(payload.error.message);
    this.name = "CorptieApiError";
    this.status = status;
    this.code = payload.error.code;
    this.retryable = payload.error.retryable;
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    await ensureCsrfToken();
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", csrfToken);
  }
  if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin"
  });
  const payload = await response.json() as T | ApiV1Error;
  if (!response.ok) throw new CorptieApiError(response.status, payload as ApiV1Error);
  return payload as T;
}

export async function getBootstrap(): Promise<BootstrapResponse> {
  const bootstrap = await apiRequest<BootstrapResponse>("/bootstrap");
  csrfToken = bootstrap.csrfToken;
  return bootstrap;
}

export async function requestPairing(input: {
  code: string;
  deviceName: string;
  permission: "read-only" | "reply" | "full-control";
}): Promise<PairingRequestResponse> {
  return pairingRequest<PairingRequestResponse>("/pair/requests", input);
}

export async function claimPairing(
  requestId: string,
  exchangeToken: string,
  signal?: AbortSignal
): Promise<PairingClaimResponse> {
  const claim = await pairingRequest<PairingClaimResponse>(
    `/pair/requests/${encodeURIComponent(requestId)}/claim`,
    { exchangeToken },
    signal
  );
  if (claim.csrfToken) csrfToken = claim.csrfToken;
  return claim;
}

export function createSession(input: {
  workspace: string;
  agent: "codex" | "claude";
  model?: string;
  reasoningLevel?: string;
  sandbox: string;
  approvalPolicy: string;
  prompt: string;
  title?: string;
}) {
  return apiRequest<{ apiVersion: "1"; eventCursor: number; session: { id: string } }>("/sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getAttention(): Promise<AttentionResponse> {
  return apiRequest<AttentionResponse>("/attention");
}

export async function getSessions(): Promise<SessionsResponse> {
  try {
    const response = await apiRequest<SessionsResponse>("/sessions");
    writeSessionSnapshot(response);
    return response;
  } catch (error) {
    const snapshot = readSessionSnapshot();
    if (snapshot && (error instanceof TypeError || !navigator.onLine)) return snapshot;
    throw error;
  }
}

export function reorderSessions(sessionIds: string[]) {
  return apiRequest<SessionsResponse>("/sessions/reorder", {
    method: "POST",
    body: JSON.stringify({ sessionIds })
  });
}

export function getSession(sessionId: string): Promise<SessionResponse> {
  return apiRequest<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export function getSessionMetadata(sessionId: string) {
  return apiRequest<{
    apiVersion: "1";
    eventCursor: number;
    sessionId: string;
    branch: string | null;
    avatarUrl: string | null;
    accountUsage: Record<string, unknown> | null;
    contextUsage: Record<string, unknown> | null;
  }>(`/sessions/${encodeURIComponent(sessionId)}/metadata`);
}

export function getCollaborationOverview() {
  return apiRequest<{
    apiVersion: "1"; eventCursor: number;
    agents: Array<Record<string, unknown>>;
    services: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
  }>("/collaboration");
}

export function getCollaborationTask(taskId: string) {
  return apiRequest<{
    apiVersion: "1"; eventCursor: number;
    task: Record<string, unknown>;
    deliveries: Array<Record<string, unknown>>;
  }>(`/collaboration/tasks/${encodeURIComponent(taskId)}`);
}

export function performCollaborationAction(
  action: "task.cancel" | "delivery.retry",
  targetId: string,
  reason: string,
  idempotencyKey: string
) {
  return apiRequest<Record<string, unknown>>("/collaboration/actions", {
    method: "POST",
    body: JSON.stringify({ action, targetId, reason }),
    idempotencyKey
  });
}

export function getTurnDiff(sessionId: string, turnId: string) {
  return apiRequest<{ apiVersion: "1"; eventCursor: number; sessionId: string; turnId: string; files: string[]; diff: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/diff`
  );
}

export function performTurnAction(
  sessionId: string,
  turnId: string,
  action: "undo" | "open-diff" | "open-finder"
) {
  return apiRequest<Record<string, unknown>>(
    `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/actions`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
      idempotencyKey: `turn:${sessionId}:${turnId}:${action}`
    }
  );
}

export function performSessionAction(
  sessionId: string,
  action: string,
  payload: Record<string, unknown>,
  idempotencyKey: string
) {
  return apiRequest<{
    apiVersion: "1";
    operationId: string;
    status: "accepted" | "succeeded" | "failed" | "result-unknown";
    accepted: boolean;
    sessionRevision: number | null;
    result: Record<string, unknown>;
  }>(`/sessions/${encodeURIComponent(sessionId)}/actions`, {
    method: "POST",
    body: JSON.stringify({ action, payload }),
    idempotencyKey
  });
}

export function getOperation(operationId: string) {
  return apiRequest<{
    apiVersion: "1";
    operationId: string;
    status: "accepted" | "succeeded" | "failed" | "result-unknown";
    accepted: boolean;
    sessionRevision: number | null;
    result: Record<string, unknown>;
  }>(`/operations/${encodeURIComponent(operationId)}`);
}

export function markAttentionRead(sessionId: string) {
  return apiRequest<{ apiVersion: "1"; sessionId: string; readAt: string }>(
    `/attention/${encodeURIComponent(sessionId)}/read`,
    { method: "POST", body: "{}" }
  );
}

export function resetApiSessionForTests() {
  csrfToken = null;
  csrfBootstrapPromise = null;
}

async function ensureCsrfToken() {
  if (csrfToken) return;
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = getBootstrap()
      .then(() => undefined)
      .finally(() => {
        csrfBootstrapPromise = null;
      });
  }
  await csrfBootstrapPromise;
}

async function pairingRequest<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal
  });
  const payload = await response.json() as T | ApiV1Error;
  if (!response.ok) throw new CorptieApiError(response.status, payload as ApiV1Error);
  return payload as T;
}
