function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function", name, description, deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const artifactId = { type: "string", pattern: "^artifact:", description: "Stable Work-scoped Artifact identity." };
const version = { type: "integer", minimum: 1 };
const contentHash = { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact SHA-256 pinned by the active Artifact Reference." };

export const artifactDynamicTools = Object.freeze([
  tool("corptie_artifact_list", "List only Artifacts authorized for the authenticated current Work Chat or Worker Session. The authorization scope is derived by Corptie and cannot be supplied by the model.", {
    include_revoked: { type: "boolean", description: "Include logically deleted Artifacts that this Session is allowed to restore." }
  }),
  tool("corptie_artifact_get", "Read one immutable Artifact version authorized by the current Work scope. artifact_id, version, and content_hash are mandatory; raw-byte pages never drift to another version.", {
    artifact_id: artifactId, version, content_hash: contentHash,
    reference_id: { type: "string", pattern: "^artifact_reference:", description: "Exact active Reference authorizing this body read." },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 65536 },
    format: { type: "string", enum: ["text", "base64"] }
  }, ["artifact_id", "version", "content_hash"]),
  tool("corptie_artifact_search", "Search bounded Artifact metadata across only Artifacts authorized for the authenticated Session. Private bodies remain available only through fixed get pages.", {
    query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 },
    scope: { type: "string", enum: ["work", "task"] },
    kinds: { type: "array", items: { type: "string" } },
    category_prefix: { type: "string" },
    tags: { type: "array", items: { type: "string" } }
  }, ["query"]),
  tool("corptie_artifact_create", "Create either an Work-public Artifact or a current-Task Artifact. Every Work Session in the Work can manage Work-public Artifacts; another Task's Artifact is read-only. Worker creation remains idempotent.", {
    title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
    visibility: { type: "string", enum: ["work_private", "task_private", "session_private", "repository_tracked"] },
    bound_task_id: { type: "string" }, bound_session_id: { type: "string" },
    repository_locator: { type: "string" }, confirmed_repository_tracked: { type: "boolean" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] },
    scope: { type: "string", enum: ["work", "task"] },
    kind: { type: "string" }, category_path: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    relation: { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"], description: "Worker Reference relation. Defaults to acceptance_evidence." },
    required: { type: "boolean", description: "Whether the Worker Reference is required. Defaults to false." },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"], description: "Worker Reference version policy. Defaults to fixed; its initial pin is always version 1 and the initial content hash." },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200, description: "Required for Worker creation. Stable within the authenticated Session; retry the same input with the same key." }
  }, ["title"]),
  tool("corptie_artifact_update_metadata", "Update the title, summary, kind, hierarchical category path, tags, aliases, or keywords of a manageable Artifact.", {
    artifact_id: artifactId, title: { type: "string", minLength: 1 }, summary: { type: "string" },
    kind: { type: "string" }, category_path: { type: "string" },
    tags: { type: "array", items: { type: "string" } }, aliases: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } }
  }, ["artifact_id"]),
  tool("corptie_artifact_publish_version", "Publish a new immutable version. For the current Task's private Artifact, expected_resource_version, expected_pinned_version, expected_pinned_hash, and idempotency_key are required and the active fixed Reference is atomically repinned. Work-public Artifacts use their normal shared management policy.", {
    artifact_id: artifactId, content: { type: "string" }, summary: { type: "string" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] },
    reference_id: { type: "string", pattern: "^artifact_reference:" },
    expected_resource_version: { type: "integer", minimum: 1 },
    expected_pinned_version: { type: "integer", minimum: 1 },
    expected_pinned_hash: contentHash,
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
  }, ["artifact_id", "content"]),
  tool("corptie_artifact_reference", "Create an explicit versioned Reference. Worker Sessions may target only their current Task or Session.", {
    artifact_id: artifactId, task_id: { type: "string" }, session_id: { type: "string" },
    relation: { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"] },
    required: { type: "boolean" }, version_policy: { type: "string", enum: ["fixed", "latest_approved"] }, version
  }, ["artifact_id", "relation"]),
  tool("corptie_artifact_revoke_reference", "Revoke a manageable explicit Task or Session Artifact Reference with an audit reason.", {
    reference_id: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }
  }, ["reference_id", "reason"]),
  tool("corptie_artifact_delete", "Logically delete a manageable Artifact while retaining immutable versions and audit history.", {
    artifact_id: artifactId, reason: { type: "string", minLength: 1 }
  }, ["artifact_id", "reason"]),
  tool("corptie_artifact_restore", "Restore a logically deleted manageable Artifact.", {
    artifact_id: artifactId
  }, ["artifact_id"])
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
    turnExecutionId: input.turnExecutionId ?? input.turnId ?? input.metadata?.turnExecutionId,
    workId: input.metadata?.workId,
    taskId: input.metadata?.taskId,
    providerBindingId: input.metadata?.providerBindingId
  };
  switch (input.tool) {
    case "corptie_artifact_list": return { artifacts: service.list(context, { includeRevoked: args.include_revoked }) };
    case "corptie_artifact_get": return service.get(context, args.artifact_id, {
      version: args.version, contentHash: args.content_hash, offset: args.offset,
      referenceId: args.reference_id, limit: args.limit, format: args.format,
      turnExecutionId: context.turnExecutionId
    });
    case "corptie_artifact_search": return service.search(context, args.query, {
      limit: args.limit, scope: args.scope, kinds: args.kinds,
      categoryPrefix: args.category_prefix, tags: args.tags
    });
    case "corptie_artifact_create": return service.create(context, {
      title: args.title, summary: args.summary, content: args.content, visibility: args.visibility,
      boundTaskId: args.bound_task_id, boundSessionId: args.bound_session_id,
      repositoryLocator: args.repository_locator, confirmedRepositoryTracked: args.confirmed_repository_tracked,
      mimeType: args.mime_type, approvalStatus: args.approval_status,
      scope: args.scope, kind: args.kind, categoryPath: args.category_path,
      tags: args.tags, aliases: args.aliases, keywords: args.keywords,
      relation: args.relation, required: args.required, versionPolicy: args.version_policy,
      idempotencyKey: args.idempotency_key
    });
    case "corptie_artifact_update_metadata": return service.updateMetadata(context, args.artifact_id, {
      title: args.title, summary: args.summary, kind: args.kind, categoryPath: args.category_path,
      tags: args.tags, aliases: args.aliases, keywords: args.keywords
    });
    case "corptie_artifact_publish_version": return service.publishVersion(context, args.artifact_id, {
      content: args.content, summary: args.summary, mimeType: args.mime_type, approvalStatus: args.approval_status,
      referenceId: args.reference_id, expectedResourceVersion: args.expected_resource_version,
      expectedPinnedVersion: args.expected_pinned_version, expectedPinnedHash: args.expected_pinned_hash,
      idempotencyKey: args.idempotency_key
    });
    case "corptie_artifact_reference": return service.createReference(context, args.artifact_id, {
      taskId: args.task_id, sessionId: args.session_id, relation: args.relation,
      required: args.required, versionPolicy: args.version_policy, version: args.version
    });
    case "corptie_artifact_revoke_reference": return service.revokeReference(context, args.reference_id, args.reason);
    case "corptie_artifact_delete": return service.revokeArtifact(context, args.artifact_id, args.reason);
    case "corptie_artifact_restore": return service.restoreArtifact(context, args.artifact_id);
    default: {
      const error = new Error(`Unsupported Artifact tool: ${input.tool}`);
      error.code = "HOST_TOOL_UNSUPPORTED";
      throw error;
    }
  }
}

export function authorizeArtifactDynamicTool({ tool, metadata } = {}) {
  const scoped = ["workChat", "worker"].includes(metadata?.sessionKind)
    && Boolean(metadata?.workId && metadata?.sessionId);
  if (!scoped) return false;
  if (["corptie_artifact_list", "corptie_artifact_get", "corptie_artifact_search", "corptie_artifact_create",
    "corptie_artifact_update_metadata", "corptie_artifact_publish_version", "corptie_artifact_reference",
    "corptie_artifact_revoke_reference", "corptie_artifact_delete", "corptie_artifact_restore"].includes(tool)) return true;
  return metadata.sessionKind === "workChat";
}
