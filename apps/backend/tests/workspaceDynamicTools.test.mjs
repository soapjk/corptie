import assert from "node:assert/strict";
import test from "node:test";
import {
  isWorkspaceDynamicTool,
  workspaceDynamicTools
} from "../src/runtime/workspaceDynamicTools.mjs";

test("workspace tools are eager host-owned operations with bounded schemas", () => {
  assert.deepEqual(
    workspaceDynamicTools.map((tool) => tool.name),
    ["corptie_list_workspaces", "corptie_create_worktree", "corptie_switch_workspace"]
  );
  assert.ok(workspaceDynamicTools.every((tool) => tool.deferLoading === false));
  assert.ok(workspaceDynamicTools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.equal(
    workspaceDynamicTools[1].inputSchema.properties.target_path.description.includes("Absolute"),
    true
  );
  assert.equal(
    workspaceDynamicTools[2].inputSchema.properties.target_worktree_id.description.includes("Opaque"),
    true
  );
});

test("workspace tool detection does not capture collaboration tools", () => {
  assert.equal(isWorkspaceDynamicTool("corptie_create_worktree"), true);
  assert.equal(isWorkspaceDynamicTool("corptie_switch_workspace"), true);
  assert.equal(isWorkspaceDynamicTool("corptie_list_workspaces"), true);
  assert.equal(isWorkspaceDynamicTool("corptie_collaboration_request"), false);
});
