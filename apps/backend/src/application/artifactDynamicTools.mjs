function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function", name, description, deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const artifactId = { type: "string", pattern: "^artifact:", description: "Stable Objective-scoped Artifact identity." };
const version = { type: "integer", minimum: 1 };

export const artifactDynamicTools = Object.freeze([
  tool("corptie_artifact_list", "List only Artifacts authorized for the authenticated current Objective Chat or Worker Session. The authorization scope is derived by Corptie and cannot be supplied by the model.", {
    include_revoked: { type: "boolean", description: "Objective Chat only. Include revoked audit records." }
  }),
  tool("corptie_artifact_get", "Read one authorized Artifact version on demand. Content is paged and every read records artifactId, version, hash, Session, and byte range.", {
    artifact_id: artifactId, version, offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 65536 }
  }, ["artifact_id"]),
  tool("corptie_artifact_search", "Search metadata and bounded local private content across only Artifacts authorized for the authenticated Session.", {
    query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }
  }, ["query"]),
  tool("corptie_artifact_create", "Objective Chat only. Create an Objective-private Artifact in Corptie's private application data, never in a Repository or chat history.", {
    title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
    visibility: { type: "string", enum: ["objective_private", "work_item_private", "session_private", "repository_tracked"] },
    bound_work_item_id: { type: "string" }, bound_session_id: { type: "string" },
    repository_locator: { type: "string" }, confirmed_repository_tracked: { type: "boolean" },
    mime_type: { type: "string" }, approval_status: { type: "string", enum: ["draft", "approved"] }
  }, ["title", "visibility"]),
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

export async function callArtifactDynamicTool(service, input = {}) {
  const args = input.arguments ?? {};
  const context = {
    actorId: input.actorId,
    sessionId: input.metadata?.sessionId,
    objectiveId: input.metadata?.objectiveId,
    workItemId: input.metadata?.workItemId
  };
  switch (input.tool) {
    case "corptie_artifact_list": return { artifacts: service.list(context, { includeRevoked: args.include_revoked }) };
    case "corptie_artifact_get": return service.get(context, args.artifact_id, { version: args.version, offset: args.offset, limit: args.limit });
    case "corptie_artifact_search": return service.search(context, args.query, { limit: args.limit });
    case "corptie_artifact_create": return service.create(context, {
      title: args.title, summary: args.summary, content: args.content, visibility: args.visibility,
      boundWorkItemId: args.bound_work_item_id, boundSessionId: args.bound_session_id,
      repositoryLocator: args.repository_locator, confirmedRepositoryTracked: args.confirmed_repository_tracked,
      mimeType: args.mime_type, approvalStatus: args.approval_status
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
