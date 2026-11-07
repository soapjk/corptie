import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_GATEWAY_INSTRUCTIONS } from "../src/application/toolGatewayInstructions.mjs";
import { collaborationRuntimeInstructions } from "../src/application/collaborationRuntimeInstructions.mjs";
import { skillMcpTurnContext } from "../src/application/skillMcpTurnContext.mjs";
import { AgentContextService } from "../src/application/agentContextService.mjs";

test("startup and Turn share the same Provider-neutral gateway routing contract", () => {
  for (const kind of ["worker", "workChat", "assistantChat"]) {
    const prompt = collaborationRuntimeInstructions("agent:one", { sessionKind: kind });
    assert.ok(prompt.includes(TOOL_GATEWAY_INSTRUCTIONS));
    assert.match(prompt, /gateway tool discovery is allowed and is not recipient discovery/);
    assert.doesNotMatch(prompt, /channel_open directly/);
  }
  assert.ok(skillMcpTurnContext("one").prompt.includes(TOOL_GATEWAY_INSTRUCTIONS));
  assert.match(TOOL_GATEWAY_INSTRUCTIONS, /Do not invoke that business name as a native tool/);
  assert.match(TOOL_GATEWAY_INSTRUCTIONS, /domain invocation.expectedCatalogVersion/);
  assert.match(TOOL_GATEWAY_INSTRUCTIONS, /does not.*grant authorization/);
});

test("lazy Skill instructions discover both operations instead of assuming native tools", async () => {
  const service = new AgentContextService({ store: { getAgent: () => ({ agentId: "agent:one", name: "One" }) },
    hubService: {}, resolveAgentSkills: async () => [{ skillId: "skill:one", name: "One" }] });
  const result = await service.buildAgentContext("agent:one", { includeMemories: false });
  assert.match(result.instructions, /discover corptie_skill_search through corptie_tool_catalog_search/);
  assert.match(result.instructions, /discover and invoke corptie_skill_load/);
  assert.match(result.instructions, /restricted_gateway operations must use corptie_tool_call/);
});
