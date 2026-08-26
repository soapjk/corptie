import { SESSION_KIND } from "../utils/sessionKinds.mjs";

const completedWorkItemStatuses = new Set(["done", "complete", "completed"]);

export function isCompletedWorkItemStatus(status) {
  return completedWorkItemStatuses.has(String(status ?? "").trim().toLowerCase());
}

export function resolveSessionArchiveState(session, { workItemStatus = null } = {}) {
  const sessionKind = session?.sessionKind ?? session?.session_kind ?? SESSION_KIND.legacy;
  if (sessionKind === SESSION_KIND.worker && isCompletedWorkItemStatus(workItemStatus)) {
    return { archived: true, reason: "workItemCompleted" };
  }
  if (session?.archived === true || Number(session?.archived) === 1) {
    return {
      archived: true,
      reason: sessionKind === SESSION_KIND.assistantChat ? "manual" : "system"
    };
  }
  return { archived: false, reason: null };
}

export function assertManualSessionArchiveAllowed(session) {
  const sessionKind = session?.sessionKind ?? session?.session_kind ?? SESSION_KIND.legacy;
  if (sessionKind === SESSION_KIND.assistantChat) return session;
  const error = new Error("Only Assistant Sessions can be archived or restored manually.");
  error.code = "SESSION_MANUAL_ARCHIVE_UNSUPPORTED";
  error.statusCode = 409;
  error.sessionId = session?.id ?? null;
  error.sessionKind = sessionKind;
  throw error;
}
