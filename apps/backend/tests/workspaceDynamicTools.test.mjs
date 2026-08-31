import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("mutating workspace tools require an explicit direct-user request", () => {
  const create = workspaceDynamicTools.find((definition) => definition.name === "corptie_create_worktree");
  const switchWorkspace = workspaceDynamicTools.find((definition) => definition.name === "corptie_switch_workspace");
  assert.match(create.description, /only when the direct user explicitly requests/u);
  assert.match(create.description, /Ordinary development work is not authorization/u);
  assert.match(switchWorkspace.description, /only when the direct user explicitly requests/u);
});

test("Session runtime instructions default to the programmatically bound Workspace", async () => {
  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(serverSource, /Continue in the active bound Workspace by default/u);
  assert.match(serverSource, /never create, select, or switch a Worktree on your own/u);
  assert.match(serverSource, /ordinary development, fixing, testing, committing, or inspection is not implicit authorization/u);
});
