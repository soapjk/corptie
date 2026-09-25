import assert from "node:assert/strict";
import test from "node:test";
import { CHART_PRESENTATION_INSTRUCTIONS } from "../src/application/chartPresentationInstructions.mjs";
import { collaborationRuntimeInstructions } from "../src/application/collaborationRuntimeInstructions.mjs";

test("optional chart syntax is provider-neutral and bounded", () => {
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /optional/);
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /do not.*invent data/i);
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /```corptie-chart/);
  for (const type of ["bar", "pie", "line"]) {
    assert.match(CHART_PRESENTATION_INSTRUCTIONS, new RegExp(type));
  }
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /4 charts/);
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /100 points/);
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /32 KiB/);
  assert.match(CHART_PRESENTATION_INSTRUCTIONS, /unique category labels/);
  assert.doesNotMatch(CHART_PRESENTATION_INSTRUCTIONS, /Codex|Claude/);
});

test("chart syntax is included once for Worker, Work Chat, and Chat sessions", () => {
  for (const sessionKind of ["worker", "workChat", "assistantChat"]) {
    const instructions = collaborationRuntimeInstructions("agent:test", { sessionKind });
    assert.equal(instructions.split("```corptie-chart").length - 1, 1);
    assert.match(instructions, /Your stable Corptie identity is agent:test/);
    assert.match(instructions, /do not.*invent data/i);
    assert.match(instructions, /Use \$corptie-collaboration/);
    if (sessionKind === "worker") {
      assert.match(instructions, /Task Worktree/);
    } else {
      assert.doesNotMatch(instructions, /programmatically binds the Task Worktree/);
      assert.match(instructions, /direct user's requested work takes priority/);
    }
  }
});
