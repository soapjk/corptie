const object = (properties, required = []) => ({
  type: "object", properties, required, additionalProperties: false
});
const text = { type: "string", minLength: 1 };

export const sceneDynamicTools = Object.freeze([
  {
    name: "corptie_scene_list",
    description: "List scene instances accessible to the authenticated Session.",
    inputSchema: object({})
  },
  {
    name: "corptie_scene_read_view",
    description: "Read a bounded declarative view from a bound scene instance.",
    inputSchema: object({
      instance_id: text,
      view_id: text,
      limit: { type: "integer", minimum: 1, maximum: 500 },
      offset: { type: "integer", minimum: 0 }
    }, ["instance_id", "view_id"])
  },
  {
    name: "corptie_scene_preview_command",
    description: "Validate a scene command and return an expiring, version-bound preview. This never commits data.",
    inputSchema: object({
      instance_id: text,
      command: { type: "string", enum: ["createRecord", "updateRecord", "completeItem", "archiveRecord", "batchApply"] },
      payload: { type: "object", additionalProperties: true },
      expected_instance_revision: { type: "integer", minimum: 0 }
    }, ["instance_id", "command", "payload"])
  },
  {
    name: "corptie_scene_commit_preview",
    description: "Commit one exact, unexpired scene preview for the authenticated Session.",
    inputSchema: object({ preview_token: text, idempotency_key: text }, ["preview_token", "idempotency_key"])
  }
]);

export function callSceneDynamicTool(service, input) {
  const sessionId = input.metadata?.sessionId;
  if (!sessionId) throw toolError("SESSION_AUTHENTICATION_REQUIRED", "Scene tools require an authenticated Session.", 403);
  const args = input.arguments ?? {};
  if (input.tool === "corptie_scene_list") {
    return { scenes: service.listScenes().filter((scene) => service.sessionCanAccess(scene.instanceId, sessionId)) };
  }
  if (input.tool === "corptie_scene_commit_preview") {
    return service.commitPreview(args.preview_token, { sessionId, idempotencyKey: args.idempotency_key });
  }
  const instanceId = args.instance_id;
  if (!service.sessionCanAccess(instanceId, sessionId)) {
    throw toolError("SCENE_ACCESS_DENIED", "Session is not bound to this scene instance.", 403);
  }
  if (input.tool === "corptie_scene_read_view") {
    return service.readView(instanceId, args.view_id, { limit: args.limit, offset: args.offset });
  }
  if (input.tool === "corptie_scene_preview_command") {
    return service.previewCommand({
      instanceId,
      command: args.command,
      payload: args.payload,
      expectedInstanceRevision: args.expected_instance_revision,
      sourceKind: "session",
      sourceSessionId: sessionId
    });
  }
  throw toolError("SCENE_TOOL_NOT_FOUND", `Unknown scene tool: ${input.tool}`, 404);
}

function toolError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
