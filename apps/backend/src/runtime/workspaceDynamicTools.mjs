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

export const workspaceDynamicTools = Object.freeze([
  tool(
    "corptie_list_workspaces",
    "List Corptie's registered local Git worktrees, including opaque ids accepted by corptie_switch_workspace. This is read-only.",
    {}
  ),
  tool(
    "corptie_create_worktree",
    "Create a validated Git worktree for the active repository. By default, Corptie schedules the logical Session to switch after the current turn completes.",
    {
      target_path: {
        type: "string",
        minLength: 1,
        description: "Absolute local filesystem path for the new worktree."
      },
      branch: {
        type: "string",
        minLength: 1,
        description: "Branch to create or check out."
      },
      base_ref: {
        type: "string",
        minLength: 1,
        description: "Existing commit-ish used as the new branch base. Defaults to HEAD."
      },
      create_branch: {
        type: "boolean",
        description: "Create branch with -b. Defaults to true; set false to check out an existing branch."
      },
      detach: {
        type: "boolean",
        description: "Create a detached worktree. When true, branch is ignored."
      },
      switch_after_create: {
        type: "boolean",
        description: "Schedule this logical Session to switch to the new worktree. Defaults to true."
      },
      inventory_version: {
        type: "string",
        minLength: 1,
        description: "Optional optimistic-concurrency version returned by workspace discovery."
      },
      continuation_checkpoint: {
        type: "string",
        minLength: 1,
        description: "Optional concise description of the remaining work Corptie should continue automatically after switching."
      },
      idempotency_key: {
        type: "string",
        minLength: 1,
        description: "Optional retry key. Reusing it with identical input returns the original result; different input is rejected."
      }
    },
    ["target_path"]
  ),
  tool(
    "corptie_switch_workspace",
    "Schedule the active logical Session to switch to an existing registered worktree after the current turn completes.",
    {
      target_worktree_id: {
        type: "string",
        minLength: 1,
        description: "Opaque worktree id from Corptie's workspace inventory."
      },
      continuation_checkpoint: {
        type: "string",
        minLength: 1,
        description: "Optional concise description of the remaining work Corptie should continue automatically after switching."
      }
    },
    ["target_worktree_id"]
  )
]);

export function isWorkspaceDynamicTool(name) {
  return workspaceDynamicTools.some((toolDefinition) => toolDefinition.name === name);
}
