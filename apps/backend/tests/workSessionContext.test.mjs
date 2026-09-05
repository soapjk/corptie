import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkSessionContext,
  mergeWorkerSessionContexts,
  WORKER_SESSION_CONTEXT_LIMITS
} from "../src/application/workSessionContext.mjs";

function workerContext() {
  return buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      taskId: "task:strict",
      workId: "work:quality"
    },
    task: {
      id: "task:strict",
      work_id: "work:quality",
      title: "Strict association validation",
      description: "Reject invalid bindings.",
      goal: "Keep the binding exact.",
      acceptance_criteria: "No partial writes.",
      verification_criteria: "Run the focused test.",
      revision: 3,
      resource_version: 7
    },
    work: {
      id: "work:quality",
      name: "Improve reliability",
      idealState: "Every provider path remains neutral as the system evolves."
    }
  });
}

test("Worker Session context preserves normal handling for in-scope requests", () => {
  const context = workerContext();

  assert.match(context.prompt, /authoritative Task binding/);
  assert.match(context.prompt, /Handle requests within the bound Task scope normally/);
  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.match(context.prompt, /"goal":"Keep the binding exact\."/);
  assert.match(context.prompt, /"verificationCriteria":"Run the focused test\."/);
  assert.match(context.prompt, /"revision":3,"resourceVersion":7/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /scope=work/);
  assert.match(context.prompt, /another Task are not exposed/);
});

test("Worker Session context continues otherwise-allowed requests outside the Task scope", () => {
  const context = workerContext();

  assert.match(context.prompt, /direct user request may extend beyond the Task title, description, or acceptance criteria/);
  assert.match(context.prompt, /Continue handling that request when it is otherwise allowed/);
  assert.match(context.prompt, /note must not replace, delay, or block the requested work/);
  assert.match(context.prompt, /Never refuse a request solely because it is outside the bound Task scope/);
  assert.doesNotMatch(context.prompt, /do not execute the unrelated task/);
});

test("Worker Session context retains safety, permission, and lifecycle constraints", () => {
  const context = workerContext();

  assert.match(context.prompt, /does not weaken or override higher-priority instructions, safety rules, authorization, permissions, confirmation requirements, or exact-target lifecycle controls/);
  assert.match(context.prompt, /refuse, pause, or request authorization only when one of those constraints requires it/);
  assert.match(context.prompt, /does not rebind this Session or authorize lifecycle operations on a different Task/);
});

test("Worker Session context includes its bound Task and Work details", () => {
  const context = buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      taskId: "task:strict",
      workId: "work:quality"
    },
    task: {
      id: "task:strict",
      work_id: "work:quality",
      title: "Strict association validation",
      description: "Reject invalid bindings.",
      acceptance_criteria: "No partial writes.",
      revision: 1,
      resource_version: 1
    },
    work: {
      id: "work:quality",
      name: "Improve reliability",
      idealState: "Every provider path remains neutral as the system evolves."
    }
  });

  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.match(context.prompt, /"description":"Reject invalid bindings\."/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /scope=task/);
  assert.match(context.prompt, /full-text search/);
});

test("Worker Session context prefers applied project-code tools with bounded fallback", () => {
  const context = buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      taskId: "task:strict",
      workId: "work:quality"
    },
    task: {
      id: "task:strict",
      work_id: "work:quality",
      title: "Search efficiently",
      revision: 1,
      resource_version: 1
    },
    toolDomains: ["artifacts", "project-code"],
    toolCatalogVersion: "catalog:project-code:1"
  });

  assert.match(context.prompt, /use corptie_project_code_search first/);
  assert.match(context.prompt, /corptie_project_code_read/);
  assert.match(context.prompt, /do not search or load the domain first/);
  assert.match(context.prompt, /expected_catalog_version=catalog:project-code:1/);
  assert.match(context.prompt, /Fall back to Provider-native search or rg only when/);
  assert.match(context.prompt, /does not apply to builds, tests, Git operations/);
});

test("detailed multilingual Task context fits the Provider-safe Worker budget", () => {
  const requirement = "远程 Workspace 与 Worktree 必须保持 Provider-neutral、隔离、可恢复，并验证断线与取消。\n";
  const acceptance = "远端命令、Git、构建测试和进程管理必须在绑定 Worktree 内执行，不能静默回退本机。\n";
  const context = buildWorkSessionContext({
    session: {
      id: "session:remote-workspace",
      sessionKind: "worker",
      taskId: "task:remote-workspace",
      workId: "work:corptie"
    },
    task: {
      id: "task:remote-workspace",
      work_id: "work:corptie",
      title: "SSH远程Workspace与远端Worktree统一管理",
      description: requirement.repeat(40),
      acceptance_criteria: acceptance.repeat(12),
      verification_criteria: "运行相关自动化测试并启动 Development app 与 backend。",
      revision: 1,
      resource_version: 2
    },
    work: { id: "work:corptie", name: "Corptie", profile: "general" },
    toolDomains: ["project-code"],
    toolCatalogVersion: "catalog:project-code:1"
  });

  assert.ok(Buffer.byteLength(context.prompt) > 7_168);
  assert.match(context.prompt, /SSH远程Workspace与远端Worktree统一管理/);
  assert.match(context.prompt, /不能静默回退本机/);
});

test("Worker Session context does not advertise an unapplied project-code domain", () => {
  const context = workerContext();
  assert.doesNotMatch(context.prompt, /corptie_project_code_search/);
});

test("Worker Session context rejects a mismatched Task", () => {
  assert.throws(
    () => buildWorkSessionContext({
      session: {
        id: "session:strict",
        sessionKind: "worker",
        taskId: "task:strict",
        workId: "work:quality"
      },
      task: {
        id: "task:other",
        work_id: "work:quality",
        title: "Another task",
        revision: 1,
        resource_version: 1
      }
    }),
    (error) => error.code === "WORK_SESSION_BINDING_MISMATCH"
  );
});

test("large optional Artifact indexes preserve the complete Task core and disclose omissions", () => {
  const task = {
    id: "task:strict", work_id: "work:quality", title: "控制台 UI 持续迭代",
    description: "长期承接控制台 UI 相关的优化与迭代需求，包括界面布局、视觉样式、交互体验、响应式适配、可访问性及性能优化；具体范围以每次在本任务中提出的需求为准，并持续记录实施内容与结果。",
    goal: "Keep the long-running task open.",
    acceptance_criteria: "每次需求记录并明确范围\n按当次需求完成实现与验证\n无明显功能回归或性能下降\n长期任务保持开放",
    verification_criteria: "Run risk-matched tests and launch the Development app.",
    revision: 9, resource_version: 14
  };
  const artifacts = Array.from({ length: 80 }, (_, index) => ({
    artifactId: `artifact:${index}`, title: `Optional ${index}`, summary: "x".repeat(900),
    required: index === 0, pinnedVersion: index === 0 ? 4 : 1,
    contentHash: index === 0 ? "b".repeat(64) : "a".repeat(64)
  }));
  const context = buildWorkSessionContext({
    session: { id: "session:strict", sessionKind: "worker", taskId: task.id, workId: task.work_id },
    task, work: { id: task.work_id, name: "Quality" },
    artifactIndex: { items: artifacts, omittedCount: 4, omissionReasons: { item_limit: 4 } }
  });

  assert.ok(Buffer.byteLength(context.prompt) <= WORKER_SESSION_CONTEXT_LIMITS.baseMaxUtf8Bytes);
  assert.match(context.prompt, /"title":"控制台 UI 持续迭代"/);
  assert.match(context.prompt, /每次需求记录并明确范围/);
  assert.match(context.prompt, /长期任务保持开放/);
  assert.match(context.prompt, /"artifactId":"artifact:0"/);
  assert.match(context.prompt, /"pinnedVersion":4,"contentHash":"b{64}"/);
  assert.match(context.prompt, /"worker_context_budget":/);
  assert.doesNotMatch(context.prompt, /…\d+ tokens truncated…/);
  assert.ok(context.contextBudget.omittedOptionalArtifacts > 4);
});

test("Turn-level merging keeps Task and direct-user evidence complete and drops oversized memory", () => {
  const baseContext = workerContext();
  const directUserIntentContext = { prompt: "<direct>event:one</direct>" };
  const memoryContext = { prompt: "m".repeat(32_768), memoryRecall: { mode: "local" } };
  const merged = mergeWorkerSessionContexts({ baseContext, directUserIntentContext, memoryContext });

  assert.ok(merged.prompt.startsWith(baseContext.prompt));
  assert.match(merged.prompt, /<direct>event:one<\/direct>/);
  assert.doesNotMatch(merged.prompt, /m{100}/);
  assert.equal(merged.contextBudget.memoryContextOmitted, true);
  assert.ok(Buffer.byteLength(merged.prompt) <= WORKER_SESSION_CONTEXT_LIMITS.turnMaxUtf8Bytes);
});

test("required pinned Artifacts are non-truncatable and incomplete core context fails closed", () => {
  const task = {
    id: "task:strict", work_id: "work:quality", title: "Strict", description: "x".repeat(32_768),
    acceptance_criteria: "Must remain complete", revision: 1, resource_version: 1
  };
  assert.throws(() => buildWorkSessionContext({
    session: { id: "session:strict", sessionKind: "worker", taskId: task.id, workId: task.work_id },
    task,
    artifactIndex: { items: [{ artifactId: "artifact:required", required: true, pinnedVersion: 2, contentHash: "b".repeat(64) }] }
  }), (error) => error.code === "WORK_SESSION_CONTEXT_INCOMPLETE"
    && error.statusCode === 409
    && Number.isInteger(error.details.requiredUtf8Bytes)
    && error.message.includes(String(error.details.requiredUtf8Bytes))
    && error.message.includes(String(error.details.maxUtf8Bytes)));

  assert.throws(() => buildWorkSessionContext({
    session: { id: "session:strict", sessionKind: "worker", taskId: task.id, workId: task.work_id },
    task: { ...task, description: "short" },
    artifactIndex: { items: [], requiredOmittedCount: 1 }
  }), (error) => error.code === "WORK_SESSION_CONTEXT_INCOMPLETE"
    && error.details.missingFields.includes("requiredArtifacts"));
});

test("non-Worker Sessions do not receive Task authority context", () => {
  assert.equal(buildWorkSessionContext({
    session: { id: "session:chat", sessionKind: "assistantChat" },
    task: null
  }), null);
});
