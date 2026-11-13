// Provider payloads are translated here, including historical persisted items.
export function subagentActivityForItem(item) {
  if (item.subagentActivity?.schemaVersion === 1) return publicSubagentActivity(item.subagentActivity);
  let metadata;
  try { metadata = JSON.parse(item.rawMetadataJSON ?? "null"); } catch { return null; }
  const raw = metadata?.payload;
  if (item.type !== "subAgentActivity" || !raw || typeof raw.agentThreadId !== "string" || !raw.agentThreadId.trim()) return null;
  const event = ["started", "interacted", "completed"].includes(raw.kind) ? raw.kind : "unknown";
  // status=completed describes the notification/tool call, not the child execution.
  const status = event === "completed" ? "completed" : event === "started" ? "running" : "unknown";
  return { schemaVersion: 1, activityId: item.id, childId: raw.agentThreadId.slice(0, 200),
    name: String(raw.agentPath ?? "").split("/").filter(Boolean).at(-1)?.slice(0, 160) || "Subagent",
    event, status };
}

export function publicSubagentActivity(value) {
  if (value?.schemaVersion !== 1 || !["activityId", "childId", "name"].every(key => typeof value[key] === "string" && value[key].trim())) return null;
  return { schemaVersion: 1, activityId: value.activityId.slice(0, 300), childId: value.childId.slice(0, 200), name: value.name.slice(0, 160),
    event: ["started", "interacted", "completed"].includes(value.event) ? value.event : "unknown",
    status: ["running", "completed", "failed", "cancelled"].includes(value.status) ? value.status : "unknown" };
}
