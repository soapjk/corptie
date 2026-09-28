import { createdAtFromOrNow } from "../utils/timestamps.mjs";
import { modelFromArgs, reasoningFromArgs } from "./storedSessionProjection.mjs";

export function serializeActiveChoicePrompt(options = null, prompt = "", existing = null) {
  const source = existing && typeof existing === "object"
    ? existing
    : { prompt, options };
  const activeOptions = Array.isArray(source.options) ? source.options : options;
  if (!Array.isArray(activeOptions) || activeOptions.length < 2) {
    return null;
  }
  const normalizedOptions = activeOptions.map((option, index) => ({
    id: option.id || `option-${index}`,
    label: String(option.label ?? "").trim(),
    role: option.role ?? "message-choice",
    index: Number.isFinite(option.index) ? option.index : index,
    selected: option.selected === true
  })).filter((option) => option.label);
  if (normalizedOptions.length < 2) {
    return null;
  }
  return JSON.stringify({
    id: source.id || `choice:${Date.now()}`,
    prompt: typeof source.prompt === "string" && source.prompt.trim() ? source.prompt.trim() : prompt,
    options: normalizedOptions,
    status: "active",
    createdAt: createdAtFromOrNow(source)
  });
}

export function toSessionSummary(session) {
  if (typeof session.toSessionSummary === "function") {
    return session.toSessionSummary(session);
  }

  const latest = lastMeaningfulText(session.items ?? []);
  const status = session.status === "running" && session.items?.at(-1)?.type === "approval"
    ? "blocked"
    : session.status;

  return {
    status,
    progress: status === "running" || status === "blocked" ? 0.5 : 1,
    summary: latest || session.summary || `${session.command ?? ""} ${(session.args ?? []).join(" ")}`.trim(),
    suggestedOptions: session.suggestedOptions ?? latestSuggestedOptionsFromItems(session.items ?? []),
    accent: session.accent || "cyan"
  };
}

export function toRawStatus(session) {
  // Store reads expose the Provider-native resume id under external. Routine
  // projections are built from those reads, so omitting this source silently
  // erased a verified Claude identity on the next status or message update.
  const agentSessionId = session.agentSessionId
    ?? session.external?.agentSessionId
    ?? session.resume?.agentSessionId
    ?? null;
  return {
    command: session.command ?? null,
    args: session.args ?? [],
    provider: session.provider ?? session.external?.provider ?? null,
    resume: session.resume ?? null,
    agentSessionId,
    initialPrompt: session.initialPrompt ?? "",
    phase: session.phase ?? null,
    connectionReady: session.connectionReady === true,
    currentModel: session.currentModel ?? session.external?.currentModel ?? session.resume?.currentModel ?? modelFromArgs(session.args ?? []),
    currentReasoningLevel: session.currentReasoningLevel ?? session.external?.currentReasoningLevel ?? session.resume?.currentReasoningLevel ?? reasoningFromArgs(session.args ?? []),
    lastInputAt: session.lastInputAt ?? null,
    lastOutputAt: session.lastOutputAt ?? null,
    nextItemSeq: session.nextItemSeq ?? null,
    canResume: session.canResume === true,
    threadId: session.external?.threadId ?? null,
    sessionId: session.external?.sessionId ?? null,
    activeTurnId: session.external?.activeTurnId ?? null,
    lastSettledTurnId: session.external?.lastSettledTurnId ?? null,
    activityStatus: session.activityStatus ?? null,
    sendUnavailableReason: session.sendUnavailableReason ?? null,
    source: session.external?.source ?? null,
    sandbox: session.external?.sandbox ?? session.sandbox ?? null,
    approvalPolicy: session.external?.approvalPolicy ?? session.approvalPolicy ?? null,
    logicalSessionId: session.external?.logicalSessionId ?? null,
    workspace: session.external?.workspace ?? null,
    routingVersion: Number(session.external?.routingVersion ?? 0),
    capabilities: session.capabilities ?? null,
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null
  };
}

export function lastMeaningfulText(items) {
  for (const item of items.slice().reverse()) {
    if (item.text && item.type !== "userMessage") {
      return item.text;
    }
  }
  return "";
}

export function latestSuggestedOptionsFromItems(items) {
  for (const item of items.slice().reverse()) {
    if (item.type === "userMessage") {
      return null;
    }
    if ((item.type === "choice" || item.type === "agentMessage") && item.status !== "selected" && Array.isArray(item.options) && item.options.length >= 2) {
      return item.options;
    }
  }
  return null;
}
