const resourceType = { type: "string", enum: ["work", "task", "session", "agent", "artifact"] };
const id = { type: "string", minLength: 1, maxLength: 200 };
const cursor = { type: "string", minLength: 1, maxLength: 4096 };
const limit = { type: "integer", minimum: 1, maximum: 10 };

export const contextReadDynamicTools = Object.freeze([
  Object.freeze({
    type: "function", name: "corptie_context_search", deferLoading: false,
    description: "Search bounded, read-only Work/Task/Session/Artifact reference material in an exact target Work. The caller's Session binding never changes.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["target_work_id"],
      properties: {
        target_work_id: id, query: { type: "string", maxLength: 200 },
        resource_types: { type: "array", uniqueItems: true, maxItems: 3,
          items: { type: "string", enum: ["task", "session", "artifact"] } },
        cursor, limit
      }
    }
  }),
  Object.freeze({
    type: "function", name: "corptie_context_read", deferLoading: false,
    description: "Read one product resource or a bounded section of its persistent data by exact ID. For Session messages, query searches persistent conversation text. Artifact bodies use corptie_artifact_get with an immutable version and hash.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["target_type", "target_id"],
      properties: {
        target_type: resourceType, target_id: id,
        section: { type: "string", enum: ["overview", "definition", "summary", "tasks", "sessions", "artifacts", "messages", "message", "metadata"] },
        item_id: id, query: { type: "string", maxLength: 200 }, cursor, limit
      }
    }
  })
]);

export function callContextReadDynamicTool(service, input) {
  if (!service) throw new Error("Context read service is unavailable.");
  return service.execute(input);
}
