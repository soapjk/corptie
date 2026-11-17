import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { HostToolCatalog, TOOL_RESTRICTED_GATEWAY } from "../src/application/hostToolCatalog.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { createProjectCodeHostNamespace } from "../src/project-code/projectCodeDynamicTools.mjs";
import { createWorkspaceSessionToolAuthority } from "../src/application/workspaceSessionToolAuthority.mjs";
import { workspaceDynamicTools } from "../src/runtime/workspaceDynamicTools.mjs";
import { ExecutionChecklistService } from "../src/application/executionChecklistService.mjs";
import { executionChecklistDynamicTools, callExecutionChecklistTool } from "../src/application/executionChecklistDynamicTools.mjs";
import { handleSessionToolHttpRequest } from "../src/application/sessionToolHttpApi.mjs";
import { sessionToolTestAuthority } from "./helpers/sessionToolTestAuthority.mjs";

async function fixture(t, providerId) {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-tool-contract", manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  t.after(() => store.close());
  const agent = store.createAgent({ name: "ContractWorker" });
  const work = new WorkApplicationService({ store }).createWork({ name: "Contracts", contributorAgentIds: [agent.agentId] });
  const task = store.createTask({ workId: work.id, title: "Tool_contract", mainAgentId: agent.agentId });
  const sessionId = "session:contract";
  store.createSession({ id: sessionId, agentId: agent.agentId, title: "Contract", provider: providerId,
    workId: work.id, taskId: task.id, sessionKind: "worker", raw: { activeTurnId: "turn:contract" } });
  store.createLogicalSessionRoute({ logicalSessionId: "logical:contract", legacySessionId: sessionId,
    providerThreadId: "thread:contract", providerSessionId: "native:contract", providerId, boundCwd: "/tmp", sessionName: "Contract" });
  const logical = store.getLogicalSession("logical:contract");
  const bindingId = logical.activeBinding.bindingId;
  const checklist = new ExecutionChecklistService({ store });
  const workspace = createWorkspaceSessionToolAuthority({ store, collaborationCore: {}, getSessionWorkspaceOperations: () => ({
    listWorkspaces: metadata => ({ logicalSessionId: metadata.logicalSessionId, taskId: metadata.taskId })
  }) });
  let domainCalls = 0;
  const catalog = new HostToolCatalog([
    createProjectCodeHostNamespace({ getService: () => ({ createSnapshot: ({ logicalSessionId, signal }) => {
      domainCalls++; return { logicalSessionId, cancelled: signal?.aborted ?? false };
    } }) }),
    { id: "workspace", tools: workspaceDynamicTools, execute: workspace.callWorkspaceDynamicTool },
    { id: "execution-checklist", tools: executionChecklistDynamicTools, execute: input => callExecutionChecklistTool(checklist, input) }
  ]);
  const host = new ToolHostService({ registry: {}, catalog, resolveInvocation: sessionToolTestAuthority(store),
    coordinator: {
      assertCanonicalToolApplied: () => ({ record: { appliedCatalogVersion: catalog.snapshot().catalogVersion } }),
      store: { getSessionToolCatalogMaterialization: () => ({ status: "applied", appliedVersion: "v1", desiredVersion: "v1", exposurePlan: { ownership: {} } }) },
      observeGeneratedMcpToolsList: async () => {}
    }
  });
  const evidence = providerId === "codex-app-server"
    ? { kind: "provider-thread", providerId, threadId: "thread:contract" }
    : { kind: "provider-session", providerId, providerSessionId: "native:contract" };
  async function invoke(tool, args = {}, overrides = {}) {
    if (providerId !== "claude-sdk") return host.execute({ actorId: agent.agentId, evidence, tool, arguments: args, ...overrides });
    return new Promise((resolve, reject) => {
      handleSessionToolHttpRequest({
        request: { method: "POST", headers: {
          "x-corptie-agent-id": overrides.actorId ?? agent.agentId, "x-corptie-session-id": sessionId,
          "x-corptie-provider-binding-id": overrides.bindingId ?? bindingId
        } }, response: {}, url: new URL("http://localhost/internal/session/tool"), toolHostService: host,
        readJson: async () => ({ tool, arguments: args, metadata: { logicalSessionId: "forged" } }),
        sendJson: (_, status, result) => status === 200 ? resolve(result) : reject(Object.assign(new Error(result.error), { code: result.code })),
        errorStatus: error => error.statusCode ?? 403
      });
    });
  }
  return { store, task, sessionId, logical, bindingId, agent, host, catalog, evidence, invoke, domainCalls: () => domainCalls };
}

for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`Provider evidence → authority → catalog → domain contract (${provider})`, async t => {
    const f = await fixture(t, provider);
    assert.deepEqual(await f.invoke("corptie_project_code_snapshot"), { logicalSessionId: "logical:contract", cancelled: false });
    assert.deepEqual(await f.invoke("corptie_list_workspaces"), { logicalSessionId: "logical:contract", taskId: f.task.id });
    const plan = await f.invoke("corptie_execution_checklist_manage", { action: "get" });
    assert.equal(plan.checklist.lifecycle, "not_created");
    const gateway = await f.invoke(TOOL_RESTRICTED_GATEWAY, {
      tool: "corptie_project_code_snapshot", arguments: {}, expected_catalog_version: f.catalog.snapshot().catalogVersion
    });
    assert.equal(gateway.logicalSessionId, "logical:contract");
    assert.equal(f.domainCalls(), 2);
    await assert.rejects(f.invoke("corptie_project_code_search", { query: 42 }), { code: "TOOL_ARGUMENT_SCHEMA_INVALID" });
    await assert.rejects(f.invoke("corptie_project_code_snapshot", {}, { actorId: "foreign" }), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
    assert.equal(f.domainCalls(), 2);
    f.store.db.run("UPDATE tasks SET current_session_id=NULL WHERE id=?", [f.task.id]);
    await assert.rejects(f.invoke("corptie_project_code_snapshot"), { code: "SESSION_TOOL_EXECUTION_FORBIDDEN" });
    assert.equal(f.domainCalls(), 2);
  });

  for (const boundary of ["Provider observation", "Skill definitions"]) {
    test(`catalog reauthorizes after asynchronous ${boundary} (${provider})`, async t => {
      const f = await fixture(t, provider);
      const revoke = () => f.store.db.run("UPDATE tasks SET current_session_id=NULL WHERE id=?", [f.task.id]);
      let skillCalls = 0;
      f.host.coordinator.observeGeneratedMcpToolsList = async () => {
        await Promise.resolve();
        if (boundary === "Provider observation") revoke();
      };
      f.host.skillMcpGateway = {
        revision: () => "skill:v1",
        definitions: async () => {
          skillCalls++;
          await Promise.resolve();
          if (boundary === "Skill definitions") revoke();
          return [{ name: "skill_contract_tool" }];
        }
      };
      await assert.rejects(f.host.observeGeneratedMcpToolsList({ actorId: f.agent.agentId, evidence: f.evidence }),
        { code: "SESSION_TOOL_EXECUTION_FORBIDDEN" });
      assert.equal(skillCalls, boundary === "Provider observation" ? 0 : 1);
    });
  }

  test(`catalog and dispatch reject retired binding and forged metadata (${provider})`, async t => {
    const f = await fixture(t, provider);
    const input = { actorId: f.agent.agentId, evidence: {
      kind: "session-binding", sessionId: f.sessionId, providerBindingId: f.bindingId
    }, metadata: { logicalSessionId: "forged", providerBindingId: f.bindingId } };
    assert.equal(typeof f.host.catalogRevision(input), "string");
    f.store.db.run("UPDATE provider_thread_bindings SET state='invalid' WHERE binding_id=?", [f.bindingId]);
    assert.throws(() => f.host.catalogRevision(input), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
    assert.throws(() => f.host.appliedDefinitions(input), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
    await assert.rejects(f.host.observeGeneratedMcpToolsList(input), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
    await assert.rejects(f.invoke("corptie_project_code_snapshot"), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
    assert.equal(f.domainCalls(), 0);
  });
}

test("common boundary preserves cancellation and reauthorizes after asynchronous policy checks", async t => {
  const f = await fixture(t, "codex-app-server");
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("cancelled"), { code: "CALL_CANCELLED" }));
  await assert.rejects(f.invoke("corptie_project_code_snapshot", {}, { signal: controller.signal }), { code: "CALL_CANCELLED" });
  assert.equal(f.domainCalls(), 0);
  f.host.assertExecutionAllowed = async () => {
    f.store.db.run("UPDATE provider_thread_bindings SET state='invalid' WHERE binding_id=?", [f.bindingId]);
  };
  await assert.rejects(f.invoke("corptie_project_code_snapshot"), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
  assert.equal(f.domainCalls(), 0);
});

test("Tool Host has no unauthenticated execution fallback", async () => {
  const host = new ToolHostService({ registry: {}, catalog: new HostToolCatalog([]) });
  await assert.rejects(host.execute({ tool: "anything", metadata: { logicalSessionId: "forged", providerBindingId: "forged" } }),
    { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});
