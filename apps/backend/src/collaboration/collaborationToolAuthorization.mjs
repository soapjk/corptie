// Channel communication is authenticated by exact Session endpoints. It must
// not inherit the Work/Task constraints of Task lifecycle operations.
export function authorizeCollaborationTool({ tool, metadata } = {}) {
  if (tool?.startsWith("corptie_collaboration_tasks_")) {
    return ["workChat", "worker"].includes(metadata?.sessionKind) && Boolean(metadata?.workId);
  }
  return Boolean(metadata?.sessionId);
}
