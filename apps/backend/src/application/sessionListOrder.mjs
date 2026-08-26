export function storedSessionIdForListSession(sessionId) {
  const id = String(sessionId ?? "");
  return id.startsWith("pty:") ? id.slice(4) : id;
}
