function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function", name, description, deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const artifactId = { type: "string", pattern: "^artifact:", description: "Stable Artifact identity; management follows Work, Task, or Session ownership." };
const version = { type: "integer", minimum: 1 };
const contentHash = { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact SHA-256 pinned by the active Artifact Reference." };

export const artifactDynamicTools = Object.freeze([
  tool("corptie_artifact_list", "List project Artifacts readable by every authenticated Session, with per-Artifact management permissions derived from ownership.", {
    include_revoked: { type: "boolean", description: "Include logically deleted Artifacts that this Session is allowed to restore." }
  }),
  tool("corptie_artifact_get", "Read one immutable Artifact version from the current project. Every authenticated Session has inherent project-wide read access; artifact_id, version, and content_hash are mandatory, and raw-byte pages never drift to another version.", {
    artifact_id: artifactId, version, content_hash: contentHash,
    reference_id: { type: "string", pattern: "^artifact_reference:", description: "Exact active Reference authorizing this body read." },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 65536 },
    format: { type: "string", enum: ["text", "base64"] }
  }, ["artifact_id", "version", "content_hash"]),
  tool("corptie_artifact_search", "Search bounded Artifact metadata across only Artifacts authorized for the authenticated Session. Private bodies remain available only through fixed get pages.", {
    query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 },
    scope: { type: "string", enum: ["work", "task", "session"] },
    kinds: { type: "array", items: { type: "string" } },
    category_prefix: { type: "string" },
    tags: { type: "array", items: { type: "string" } }
  }, ["query"]),
  tool("corptie_artifact_patch", "Apply ordered exact text replacements to a current fixed Artifact version. Each old_text must match exactly once. Publishes an immutable version with concurrency protection and a durable idempotent receipt; Session and audit source are runtime-bound.", {
    artifact_id: artifactId, version, content_hash: contentHash,
    reference_id: { type: "string", pattern: "^artifact_reference:" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    edits: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", additionalProperties: false,
      properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } },
      required: ["old_text", "new_text"]
    } }
  }, ["artifact_id", "version", "content_hash", "idempotency_key", "edits"]),
  tool("corptie_artifact_promote_to_repository", "Write a fixed Artifact version to an explicitly authorized new repository Markdown path. Requires the current direct user's exact-path authorization event, refuses overwrite and symlink escape, and records durable commit evidence. Does not git add, commit or push.", {
    artifact_id: artifactId, version, content_hash: contentHash, path: { type: "string", minLength: 1 },
    user_message_event_id: { type: "string", minLength: 1 }, user_message_sequence: { type: "integer", minimum: 1 }
  }, ["artifact_id", "version", "content_hash", "path", "user_message_event_id", "user_message_sequence"]),
  tool("corptie_artifact_materialize", "Materialize a fixed Artifact version only when a local program needs a path. Writes atomically under the authenticated Session project's .corptie directory, verifies SHA-256 and Git ignore status, and refuses overwrite or unsafe paths. Never stages or commits files.", {
    artifact_id: artifactId, version, content_hash: contentHash,
    path: { type: "string", minLength: 1, description: "Safe relative path within project .corptie, e.g. artifacts/report.md. No absolute paths or parent traversal." }
  }, ["artifact_id", "version", "content_hash", "path"]),
  tool("corptie_artifact_create", "Create an Artifact using runtime-bound ownership: assistantChat defaults to its own Session, Worker to its Task, Work Chat to its Work. Workers may also create Work-scoped Artifacts. Other owners' Artifacts are read-only; creation uses a Session-scoped idempotency key.", {
    title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
    visibility: { type: "string", enum: ["work_private", "task_private", "session_private", "repository_tracked"] },
    bound_task_id: { type: "string" }, bound_session_id: { type: "string" },
    repository_locator: { type: "string" }, confirmed_repository_tracked: { type: "boolean" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] },
    scope: { type: "string", enum: ["work", "task", "session"] },
    kind: { type: "string" }, category_path: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    relation: { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"], description: "Worker Reference relation. Defaults to acceptance_evidence." },
    required: { type: "boolean", description: "Whether the Worker Reference is required. Defaults to false." },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"], description: "Worker Reference version policy. Defaults to fixed; its initial pin is always version 1 and the initial content hash." },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200, description: "Required for Worker creation. Stable within the authenticated Session; retry the same input with the same key." }
  }, ["title"]),
  tool("corptie_artifact_transfer", "Change ownership of a manageable Artifact within writable scopes. Requires management of both source and destination; read-only access cannot claim ownership. Preserves versions and references, and audits the transfer.", {
    artifact_id: artifactId, expected_resource_version: { type: "integer", minimum: 1 },
    scope: { type: "string", enum: ["work", "task", "session"] },
    task_id: { type: "string" }, session_id: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
  }, ["artifact_id", "expected_resource_version", "scope", "idempotency_key"]),
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
    case "corptie_artifact_promote_to_repository": return service.promoteToRepository(context, args.artifact_id, {
      version: args.version, contentHash: args.content_hash, path: args.path,
      eventId: args.user_message_event_id, sequence: args.user_message_sequence
    });
    case "corptie_artifact_materialize": return service.materialize(context, args.artifact_id, {
      version: args.version, contentHash: args.content_hash, path: args.path
    });
    case "corptie_artifact_transfer": return service.transferOwnership(context, args.artifact_id, {
      expectedResourceVersion: args.expected_resource_version, scope: args.scope,
      taskId: args.task_id, sessionId: args.session_id, idempotencyKey: args.idempotency_key
    });
    case "corptie_artifact_patch": return service.patch(context, args.artifact_id, {
      version: args.version, contentHash: args.content_hash, referenceId: args.reference_id,
      idempotencyKey: args.idempotency_key,
      edits: args.edits.map(edit => ({ oldText: edit.old_text, newText: edit.new_text }))
    });
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
  const scoped = Boolean(metadata?.sessionId);
  if (!scoped) return false;
  if (["corptie_artifact_promote_to_repository", "corptie_artifact_materialize", "corptie_artifact_transfer", "corptie_artifact_patch", "corptie_artifact_list", "corptie_artifact_get", "corptie_artifact_search", "corptie_artifact_create",
    "corptie_artifact_update_metadata", "corptie_artifact_publish_version", "corptie_artifact_reference",
    "corptie_artifact_revoke_reference", "corptie_artifact_delete", "corptie_artifact_restore"].includes(tool)) return true;
  return metadata.sessionKind === "workChat";
}
