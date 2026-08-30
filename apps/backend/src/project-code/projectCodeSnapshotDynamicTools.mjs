export const projectCodeSnapshotDynamicTools = Object.freeze([Object.freeze({
  type: "function",
  name: "corptie_project_code_snapshot",
  description: "Create and persist the authoritative source Snapshot for this Worker Session's current Startup-bound Worktree.",
  deferLoading: false,
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }
})]);

export function callProjectCodeSnapshotDynamicTool(service, input = {}) {
  if (input.tool !== "corptie_project_code_snapshot") {
    const error = new Error(`Unsupported project-code Snapshot tool: ${input.tool}`);
    error.code = "HOST_TOOL_UNSUPPORTED";
    throw error;
  }
  return service.createSnapshot({ logicalSessionId: input.metadata?.logicalSessionId, signal: input.signal });
}
