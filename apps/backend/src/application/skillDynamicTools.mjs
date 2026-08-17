function tool(name, description, properties, required = []) {
  return {
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
  };
}

export const skillDynamicTools = Object.freeze([
  tool(
    "corptie_skill_search",
    "Search only the Skills assigned to the current Corptie Agent. Returns compact metadata; call corptie_skill_load before following a Skill's instructions.",
    {
      intent: {
        type: "string",
        minLength: 1,
        description: "Plain-language description of the capability or workflow needed."
      }
    },
    ["intent"]
  ),
  tool(
    "corptie_skill_load",
    "Load the complete SKILL.md instructions for one Skill returned by corptie_skill_search. Access is restricted to Skills assigned to the current Agent.",
    {
      skill_id: {
        type: "string",
        minLength: 1,
        description: "Opaque Skill id returned by corptie_skill_search."
      }
    },
    ["skill_id"]
  )
]);

export async function callSkillDynamicTool(skillRegistryService, input = {}) {
  const agentId = String(input.actorId ?? input.agentId ?? "").trim();
  if (!agentId) {
    const error = new Error("The Skill tool requires an authenticated Agent identity.");
    error.code = "AGENT_REQUIRED";
    throw error;
  }
  if (input.tool === "corptie_skill_search") {
    return skillRegistryService.searchForAgent(agentId, input.arguments?.intent ?? "");
  }
  if (input.tool === "corptie_skill_load") {
    return skillRegistryService.loadForAgent(agentId, String(input.arguments?.skill_id ?? "").trim());
  }
  const error = new Error(`Unsupported Skill tool: ${input.tool}`);
  error.code = "HOST_TOOL_UNSUPPORTED";
  throw error;
}
