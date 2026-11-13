// Correlation from a real app-server callback. This is unsigned metadata, not
// attestation: never synthesize keys, review decisions or a privileged identity.
export function codexMcpRequestMetadata(params = {}) {
  const values = [params.threadId, params.turnId, params.callId];
  if (values.some(value => typeof value !== "string" || !value.trim()
    || value !== value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value))) return null;
  return { "x-codex-turn-metadata": {
    thread_id: params.threadId, turn_id: params.turnId, call_id: params.callId
  } };
}
