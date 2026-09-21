// Channel communication is authenticated by exact Session endpoints. It must
// not inherit the Work/Task constraints of Task lifecycle operations.
export function authorizeCollaborationTool({ tool, metadata } = {}) {
  // Tool visibility is Session-wide. The service validates the concrete Work,
  // Task, endpoint and operation scope at execution time.
  return Boolean(metadata?.sessionId);
}
