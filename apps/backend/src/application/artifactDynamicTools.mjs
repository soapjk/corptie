function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function", name, description, deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const artifactId = { type: "string", pattern: "^artifact:", description: "Stable Objective-scoped Artifact identity." };
const version = { type: "integer", minimum: 1 };
const contentHash = { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact SHA-256 pinned by the active Artifact Reference." };

export const artifactDynamicTools = Object.freeze([
  tool("corptie_artifact_list", "List only Artifacts authorized for the authenticated current Objective Chat or Worker Session. The authorization scope is derived by Corptie and cannot be supplied by the model.", {
    include_revoked: { type: "boolean", description: "Objective Chat only. Include revoked audit records." }
  }),
  tool("corptie_artifact_get", "Read one explicitly referenced immutable Artifact pin. artifact_id, version, and content_hash are mandatory; raw-byte pages never drift to a pending version.", {
    artifact_id: artifactId, version, content_hash: contentHash,
    reference_id: { type: "string", pattern: "^artifact_reference:", description: "Exact active Reference authorizing this body read." },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 65536 },
    format: { type: "string", enum: ["text", "base64"] }
  }, ["artifact_id", "version", "content_hash", "reference_id"]),
  tool("corptie_artifact_search", "Search bounded Artifact metadata across only Artifacts authorized for the authenticated Session. Private bodies remain available only through fixed get pages.", {
    query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }
  }, ["query"]),
  tool("corptie_artifact_create", "Create an Objective Artifact in Corptie's private application data. Objective Chat retains full creation controls. A Worker Session is server-scoped to one work_item_private Artifact plus one Reference for its authoritative current WorkItem; idempotency_key is required for Workers. Worker defaults are relation=acceptance_evidence, required=false, version_policy=fixed, with pinned_version=1 and pinned_hash equal to the immutable initial content hash.", {
    title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
    visibility: { type: "string", enum: ["objective_private", "work_item_private", "session_private", "repository_tracked"] },
    bound_work_item_id: { type: "string" }, bound_session_id: { type: "string" },
    repository_locator: { type: "string" }, confirmed_repository_tracked: { type: "boolean" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] },
    relation: { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"], description: "Worker Reference relation. Defaults to acceptance_evidence." },
    required: { type: "boolean", description: "Whether the Worker Reference is required. Defaults to false." },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"], description: "Worker Reference version policy. Defaults to fixed; its initial pin is always version 1 and the initial content hash." },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200, description: "Required for Worker creation. Stable within the authenticated Session; retry the same input with the same key." }
  }, ["title"]),
  tool("corptie_artifact_publish_version", "Objective Chat only. Publish a new immutable private version. Started WorkItems keep their pinned version and receive an audited pending-impact notice.", {
    artifact_id: artifactId, content: { type: "string" }, summary: { type: "string" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] }
  }, ["artifact_id", "content"]),
  tool("corptie_artifact_reference", "Objective Chat only. Explicitly authorize a versioned Artifact for a WorkItem or Session.", {
    artifact_id: artifactId, work_item_id: { type: "string" }, session_id: { type: "string" },
    relation: { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"] },
    required: { type: "boolean" }, version_policy: { type: "string", enum: ["fixed", "latest_approved"] }, version
  }, ["artifact_id", "relation"]),
  tool("corptie_artifact_revoke_reference", "Objective Chat only. Revoke an explicit WorkItem or Session Artifact authorization with an audit reason.", {
    reference_id: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }
  }, ["reference_id", "reason"])
]);

export async function callArtifactDynamicTool(service, input = {}, options = {}) {
  const args = input.arguments ?? {};
  const logicalSessionId = input.metadata?.logicalSessionId ?? input.metadata?.sessionId;
  if (options.toolMaterializationPort) {
    await options.toolMaterializationPort.assertCanonicalToolApplied(logicalSessionId, input.tool);
  }
  const context = {
    actorId: input.actorId,
    sessionId: input.metadata?.sessionId,
    logicalSessionId: input.metadata?.logicalSessionId,
    providerBindingId: input.metadata?.providerBindingId,
    turnExecutionId: input.turnExecutionId ?? input.turnId ?? input.metadata?.turnExecutionId,
    objectiveId: input.metadata?.objectiveId,
    workItemId: input.metadata?.workItemId
  };
  switch (input.tool) {
    case "corptie_artifact_list": return { artifacts: service.list(context, { includeRevoked: args.include_revoked }) };
    case "corptie_artifact_get": return service.get(context, args.artifact_id, {
      version: args.version, contentHash: args.content_hash, offset: args.offset,
      referenceId: args.reference_id, limit: args.limit, format: args.format,
      turnExecutionId: context.turnExecutionId
    });
    case "corptie_artifact_search": return service.search(context, args.query, { limit: args.limit });
    case "corptie_artifact_create": return service.create(context, {
      title: args.title, summary: args.summary, content: args.content, visibility: args.visibility,
      boundWorkItemId: args.bound_work_item_id, boundSessionId: args.bound_session_id,
      repositoryLocator: args.repository_locator, confirmedRepositoryTracked: args.confirmed_repository_tracked,
      mimeType: args.mime_type, approvalStatus: args.approval_status,
      relation: args.relation, required: args.required, versionPolicy: args.version_policy,
      idempotencyKey: args.idempotency_key
    });
    case "corptie_artifact_publish_version": return service.publishVersion(context, args.artifact_id, {
      content: args.content, summary: args.summary, mimeType: args.mime_type, approvalStatus: args.approval_status
    });
    case "corptie_artifact_reference": return service.createReference(context, args.artifact_id, {
      workItemId: args.work_item_id, sessionId: args.session_id, relation: args.relation,
      required: args.required, versionPolicy: args.version_policy, version: args.version
    });
    case "corptie_artifact_revoke_reference": return service.revokeReference(context, args.reference_id, args.reason);
    default: {
      const error = new Error(`Unsupported Artifact tool: ${input.tool}`);
      error.code = "HOST_TOOL_UNSUPPORTED";
      throw error;
    }
  }
}

export function authorizeArtifactDynamicTool({ tool, metadata } = {}) {
  const scoped = ["objectiveChat", "worker"].includes(metadata?.sessionKind)
    && Boolean(metadata?.objectiveId && metadata?.sessionId);
  if (!scoped) return false;
  if (["corptie_artifact_list", "corptie_artifact_get", "corptie_artifact_search", "corptie_artifact_create"].includes(tool)) return true;
  return metadata.sessionKind === "objectiveChat";
}
