function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  });
}

const scope = {
  type: "string",
  enum: ["global", "agent", "work", "task"],
  description: "Memory scope. Global applies to the local user across all Works and Tasks. Owner identity is derived from the authenticated current Session. When omitted for remember, the narrowest bound scope is used: Task, then Work, then Agent."
};
const classification = {
  primary_topic: { type: "string", enum: ["personal", "life", "fitness_health", "work_project",
    "programming", "communication", "product", "finance", "learning_creative", "other"] },
  secondary_topics: { type: "array", maxItems: 2, items: { type: "string" } },
  keywords: { type: "array", maxItems: 8, items: { type: "string" } },
  applies_to: { type: "array", maxItems: 4, items: { type: "string",
    enum: ["all", "development", "fitness", "personal", "work", "finance", "creative"] } },
  delivery_mode: { type: "string", enum: ["on_demand", "applicable_preference"] }
};

export const memoryDynamicTools = Object.freeze([
  tool(
    "corptie_memory_search",
    "Search active, non-revoked memories visible to the current Session's Agent, Work, and Task. Provide a concrete intent; an empty intent returns no ordinary memories.",
    {
      intent: {
        type: "string",
        description: "What to recall. Empty intent returns no ordinary memories."
      },
      deep_recall: {
        type: "boolean",
        description: "Request bounded semantic Deep Recall. When unavailable it clearly degrades to local lexical recall."
      }
    }
  ),
  tool(
    "corptie_memory_get",
    "Get one memory visible to the authenticated current Session, including provenance and audit metadata.",
    { memory_id: { type: "string", minLength: 1 } },
    ["memory_id"]
  ),
  tool(
    "corptie_memory_list",
    "List memories manageable from the authenticated current Session. Revoked memories are hidden unless explicitly requested so their audit trail can be inspected.",
    {
      scope,
      include_revoked: { type: "boolean", description: "Include revoked audit records. Defaults to false." }
    }
  ),
  tool(
    "corptie_memory_remember",
    "Persist a structured memory only when the user explicitly asks to remember, retain, or follow something in future. Never use this for ordinary conversation or to edit shared AGENT_MEMORY.md.",
    {
      content: { type: "string", minLength: 1, description: "Durable content explicitly requested by the user." },
      kind: {
        type: "string",
        enum: ["skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"]
      },
      scope,
      tags: { type: "array", items: { type: "string", minLength: 1 } },
      ...classification,
      idempotency_key: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Optional retry key scoped to the authenticated Session. Reusing it with identical input returns the original Memory."
      }
    },
    ["content", "kind"]
  ),
  tool(
    "corptie_memory_update",
    "Correct the content or tags of a non-revoked memory manageable from the authenticated current Session. Ownership and provenance cannot be changed.",
    {
      memory_id: { type: "string", minLength: 1 },
      content: { type: "string", minLength: 1 },
      tags: { type: "array", items: { type: "string", minLength: 1 } },
      ...classification
    },
    ["memory_id"]
  ),
  tool(
    "corptie_memory_revoke",
    "Revoke a memory manageable from the authenticated current Session. Revocation preserves provenance and stops future search or injection; physical deletion is intentionally unavailable.",
    {
      memory_id: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 }
    },
    ["memory_id"]
  )
]);

export function callMemoryDynamicTool(service, input = {}) {
  if (!service || typeof service.execute !== "function") {
    const error = new Error("Memory tools are unavailable.");
    error.code = "MEMORY_TOOLS_UNAVAILABLE";
    throw error;
  }
  return service.execute(input);
}
