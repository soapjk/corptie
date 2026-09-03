function tool(name, description, properties, required = []) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const snapshotId = { type: "string", minLength: 1, maxLength: 128, description: "Persisted RepositorySourceSnapshotReceipt receiptId from corptie_project_code_snapshot." };

export const projectCodeDynamicTools = Object.freeze([
  tool(
    "corptie_project_code_snapshot",
    "Create and persist an authoritative source Snapshot for this Worker Session's current Startup-bound Worktree.",
    {}
  ),
  tool(
    "corptie_project_code_search",
    "Search only the persisted authoritative Snapshot for this Worker Session. L0 exact search has no index startup; deeper layers are capability-gated.",
    {
      snapshot_receipt_id: snapshotId,
      query: { type: "string", minLength: 1, maxLength: 500 },
      mode: { type: "string", enum: ["auto", "exact", "files", "symbols", "semantic"] },
      paths: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
      languages: { type: "array", maxItems: 32, items: { type: "string", minLength: 1 } },
      kinds: { type: "array", maxItems: 32, items: { type: "string", minLength: 1 } },
      toolset_validation_receipt_id: {
        type: "string",
        pattern: "^toolset_validation_receipt:[A-Za-z0-9_-]+$",
        description: "Authoritative ToolsetValidationReceipt v3 id required only for L3 semantic execution."
      },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      min_results: { type: "integer", minimum: 1, maximum: 20 },
      timeout_ms: { type: "integer", minimum: 250, maximum: 10000 }
    },
    ["snapshot_receipt_id", "query"]
  ),
  tool(
    "corptie_project_code_read",
    "Read a bounded text window from a file contained by the persisted authoritative Snapshot.",
    {
      snapshot_receipt_id: snapshotId,
      path: { type: "string", minLength: 1 },
      start_line: { type: "integer", minimum: 1 },
      line_count: { type: "integer", minimum: 1, maximum: 2000 },
      max_bytes: { type: "integer", minimum: 1, maximum: 65536 }
    },
    ["snapshot_receipt_id", "path"]
  )
]);

export function createProjectCodeHostNamespace(options = {}) {
  if (typeof options.getService !== "function") {
    throw new TypeError("Project-code Host namespace requires getService().");
  }
  return Object.freeze({
    id: "project-code",
    tools: projectCodeDynamicTools,
    authorize: ({ metadata }) => metadata?.sessionKind === "worker"
      && Boolean(metadata?.logicalSessionId)
      && Boolean(metadata?.taskId)
      && Boolean(metadata?.workId),
    execute: async (input) => {
      await options.validateRoute?.(input);
      return callProjectCodeDynamicTool(options.getService(), input);
    }
  });
}

export async function callProjectCodeDynamicTool(service, input = {}) {
  if (!service) throw coded("PROJECT_CODE_SEARCH_UNAVAILABLE", "Project-code search service is unavailable.");
  const logicalSessionId = input.metadata?.logicalSessionId;
  const args = input.arguments ?? {};
  if (input.tool === "corptie_project_code_snapshot") {
    return service.createSnapshot({ logicalSessionId, signal: input.signal });
  }
  if (input.tool === "corptie_project_code_search") {
    return service.search({
      logicalSessionId,
      snapshotReceiptId: args.snapshot_receipt_id,
      query: args.query,
      mode: args.mode,
      paths: args.paths,
      languages: args.languages,
      kinds: args.kinds,
      limit: args.limit,
      minResults: args.min_results,
      timeoutMs: args.timeout_ms,
      toolsetValidationReceiptId: args.toolset_validation_receipt_id,
      toolsetRequired: args.mode === "semantic",
      signal: input.signal
    });
  }
  if (input.tool === "corptie_project_code_read") {
    return service.pointRead({
      logicalSessionId,
      snapshotReceiptId: args.snapshot_receipt_id,
      path: args.path,
      startLine: args.start_line,
      lineCount: args.line_count,
      maxBytes: args.max_bytes,
      signal: input.signal
    });
  }
  throw coded("HOST_TOOL_UNSUPPORTED", `Unsupported project-code tool: ${input.tool}`);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
