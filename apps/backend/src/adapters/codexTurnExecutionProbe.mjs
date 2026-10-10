// Read-only, bounded protocol adapter. Never resume, subscribe, or start a turn.
export async function probeCodexTurnExecution(request, threadId, turnId) {
  const base = { providerSessionId: threadId, turnId, observedAt: new Date().toISOString(), source: "native-status" };
  const response = await request("thread/read", { threadId, includeTurns: false });
  const thread = response?.thread;
  if (thread?.id !== threadId) return { ...base, state: "unknown", reasonCode: "PROBE_IDENTITY_MISMATCH" };
  const status = thread.status?.type;
  let turn;
  try {
    const page = await request("thread/turns/list", { threadId, limit: 5, sortDirection: "desc", itemsView: "notLoaded" });
    turn = page?.data?.find(item => item.id === turnId);
  } catch {
    // Experimental paging may not be supported. Never fall back to full history.
  }
  const terminalStatus = { completed: "completed", failed: "failed", interrupted: "cancelled" }[turn?.status];
  if (terminalStatus) return { ...base, state: "terminal", terminalStatus, evidenceScope: "turn", reasonCode: "NATIVE_TURN_TERMINAL" };
  if (status === "idle") return { ...base, state: "absent", evidenceScope: "session", reasonCode: "NATIVE_SESSION_IDLE" };
  if (status === "active" && turn?.status === "inProgress") {
    return { ...base, state: "running", evidenceScope: "turn", reasonCode: "NATIVE_TURN_ACTIVE" };
  }
  return { ...base, state: "unknown", reasonCode: "NATIVE_TURN_UNCONFIRMED" };
}
