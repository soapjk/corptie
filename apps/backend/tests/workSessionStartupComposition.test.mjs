import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWorkSessionStartupComposition } from "../src/application/workSessionStartupComposition.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session:1", external: { cwd: "/workspace" } };
  const store = {
    dataRoot: "/unused",
    getAgent: (id) => ({ id, name: "Worker" }),
    getSession: () => session,
    getLogicalSessionByLegacySessionId: () => ({
      logicalSessionId: "logical:1", activeBinding: {
        bindingId: "binding:1", providerSessionId: "native:1", boundCwd: "/workspace"
      }
    }),
    getSessionToolCatalogMaterialization: () => ({
      status: "applied", providerReceipt: { providerDefinitionsHash: "tool-proof" }
    }),
    getGitWorktree: () => null
  };
  const options = {
    store, workService: { getTask: () => ({ id: "task:1", title: "Task", work_id: "work:1" }) },
    agentProviderRegistry: {},
    sessionApplicationService: {
      resumeSession: async (...args) => calls.push(["resume", ...args]),
      deleteSession: async (...args) => calls.push(["delete", ...args])
    },
    forkContextForTask: async (id) => ({ taskId: id }),
    prepareConversationForkWorkspace: async () => {},
    ensureTaskWorkspace: async () => {},
    createProviderWorkSession: async (input) => { calls.push(["create", input]); return session; },
    requiredWorkspaceInstructionSources: async () => ["workspace"],
    knownGlobalInstructionSources: async () => ["global"],
    admitReliableSessionMessage: async (...args) => calls.push(["admit", ...args]),
    projectApplicationService: {}, gitWorkspaces: {}, projectCodeApplicationService: {},
    resolveSessionProviderId: (id) => id, emitEvent: () => {}
  };
  const composition = createWorkSessionStartupComposition(options);
  return {
    ...composition, store, session, calls,
    port: composition.workSessionStartupCoordinator.providerWorkSessionPort
  };
}

test("startup creation uses the assigned Agent and defers both initial dispatch and Tool finalization", async () => {
  const f = fixture();
  await f.port.createSession({
    taskId: "task:1", assigneeAgentId: "agent:1", providerId: "test",
    workspace: { canonicalExecutionPath: "/execution", canonicalWorktreePath: "/worktree" }
  });
  const input = f.calls[0][1];
  assert.equal(input.assigneeAgentId, "agent:1");
  assert.equal(input.workingDirectory, "/execution");
  assert.equal(input.deferInitialPromptUntilBound, true);
  assert.equal(input.deferToolHostFinalization, true);
  assert.deepEqual(input.forkSource, { taskId: "task:1" });
  assert.equal(f.calls.some(([kind]) => kind === "admit"), false);
});

test("activation returns exact workspace, Tool and instruction proofs without sending an initial Turn", async () => {
  const f = fixture();
  const proof = await f.port.activateSession({
    session: f.session, taskId: "task:1", assigneeAgentId: "agent:1",
    workingDirectory: "/workspace", dispatchInitialTurn: false
  });
  assert.deepEqual(proof, {
    providerResourceId: "native:1", canonicalWorkingDirectory: "/workspace",
    toolContractHash: "tool-proof",
    instructionSourcesHash: createHash("sha256").update(JSON.stringify(["global", "workspace"])).digest("hex")
  });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["resume"]);
  assert.equal(f.calls[0][2].purpose, "session-create-finalization");
});

test("activation durably admits one deterministic custom initial Turn before returning proofs", async () => {
  const f = fixture();
  const proof = await f.port.activateSession({
    session: f.session,
    taskId: "task:1",
    assigneeAgentId: "agent:1",
    workingDirectory: "/workspace",
    startupOperationId: "startup:one",
    dispatchInitialTurn: true,
    initialPrompt: "Resolve the preserved conflict."
  });
  assert.equal(proof.providerResourceId, "native:1");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["resume", "admit"]);
  assert.equal(f.calls[0][2].purpose, "session-create-finalization");
  assert.equal(f.calls[1][2], "Resolve the preserved conflict.");
  const identity = createHash("sha256").update("startup:one").digest("hex").slice(0, 32);
  assert.equal(f.calls[1][3].messageId, `startup-initial:${identity}`);
  assert.equal(f.calls[1][3].deliveryId, `delivery:startup-initial:${identity}`);
});

test("activation reports Tool finalization failures separately from initial Turn admission", async () => {
  const f = fixture();
  f.store.getSessionToolCatalogMaterialization = () => null;
  await assert.rejects(
    () => f.port.activateSession({
      session: f.session,
      taskId: "task:1",
      assigneeAgentId: "agent:1",
      workingDirectory: "/workspace",
      startupOperationId: "startup:tool-failure",
      dispatchInitialTurn: true,
      initialPrompt: "Resolve the preserved conflict."
    }),
    { code: "START_PROVIDER_BINDING_FAILED", stage: "provider_activation" }
  );
  assert.deepEqual(f.calls.map(([kind]) => kind), ["resume"]);
});

test("both execution strategies share one Provider port and one application authorization owner", () => {
  const f = fixture();
  assert.equal(f.workSessionStartApplicationService.coordinator, f.workSessionStartupCoordinator);
  assert.equal(f.workSessionStartApplicationService.managedSandboxCoordinator.providerWorkSessionPort, f.port);
});

test("compensation refuses to remove a Worktree whose inventory identity is missing", async () => {
  const f = fixture();
  const result = await f.workSessionStartupCoordinator.compensateWorktree({
    operation: {}, allocation: { worktreeId: "missing", repositoryId: "repository:1" }
  });
  assert.deepEqual(result, { manualRequired: true, removed: false });
  assert.deepEqual(f.calls, []);
});
