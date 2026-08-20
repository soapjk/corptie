import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillPackageDiscoveryAssistant,
  parseDiscoveryPlan
} from "../src/application/skillPackageDiscoveryAssistant.mjs";

test("Skill package discovery assistance runs read-only and returns a hidden structured plan", async () => {
  const calls = [];
  const assistant = createSkillPackageDiscoveryAssistant({
    backgroundAgent: {
      async run(input) {
        calls.push(input);
        return {
          text: JSON.stringify({
            packageRoot: ".",
            mcpDescriptor: ".mcp.json",
            confidence: 0.9,
            evidence: ["README declares the MCP server"]
          })
        };
      }
    }
  });
  const plan = await assistant({
    sourceRoot: "/tmp/package",
    skillRoot: "/tmp/package/skills/example",
    markerPath: "/tmp/package/skills/example/SKILL.md",
    mcpDescriptorHints: [".mcp.json"]
  });

  assert.equal(plan.mcpDescriptor, ".mcp.json");
  assert.equal(calls[0].purpose, "skill-package-discovery");
  assert.equal(calls[0].permissionProfile, "read-only");
  assert.deepEqual(calls[0].allowedRoots, ["/tmp/package"]);
  assert.match(calls[0].developerInstructions, /Return exactly one JSON object/);
});

test("Skill package discovery assistance rejects prose instead of treating it as an install plan", () => {
  assert.throws(
    () => parseDiscoveryPlan("The package probably uses .mcp.json"),
    (error) => error.code === "SKILL_ASSISTANCE_INVALID" && /有效 JSON/.test(error.message)
  );
  assert.deepEqual(
    parseDiscoveryPlan("```json\n{\"packageRoot\":\".\",\"mcpDescriptor\":\".mcp.json\"}\n```"),
    { packageRoot: ".", mcpDescriptor: ".mcp.json" }
  );
});
