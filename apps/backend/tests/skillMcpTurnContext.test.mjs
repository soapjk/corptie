import assert from "node:assert/strict";
import test from "node:test";
import { skillMcpTurnContext } from "../src/application/skillMcpTurnContext.mjs";

test("assigned Skill MCP guidance requires fixed-gateway discovery before failure", () => {
  const context = skillMcpTurnContext("assignment:one");
  assert.match(context.prompt, /corptie_tool_catalog_search/);
  assert.match(context.prompt, /corptie_tool_call/);
  assert.match(context.prompt, /no new Session or Provider binding replacement is required/);
  assert.equal(skillMcpTurnContext("none"), null);
});
