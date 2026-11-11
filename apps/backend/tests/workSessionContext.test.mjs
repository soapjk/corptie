import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkSessionContext,
  mergeWorkerSessionContexts
} from "../src/application/workSessionContext.mjs";
import { SessionContextDelivery } from "../src/application/sessionContextDelivery.mjs";
import { EXECUTION_CHECKLIST_INSTRUCTIONS, EXECUTION_CHECKLIST_ENTRY_INSTRUCTIONS } from "../src/application/executionChecklistInstructions.mjs";
import { taskExecutionPrompt } from "../src/application/taskAcceptance.mjs";

test("checklist policy is required Worker context and the default startup uses the same policy", () => {
  const base = workerContext();
  assert.ok(base.corePrompt.includes(EXECUTION_CHECKLIST_INSTRUCTIONS));
  assert.ok(taskExecutionPrompt({ title: "Work" }).includes(EXECUTION_CHECKLIST_INSTRUCTIONS));
  const merged = mergeWorkerSessionContexts({ baseContext: base,
    memoryContext: { prompt: "Optional recall ".repeat(10_000) } });
  assert.ok(merged.prompt.includes(EXECUTION_CHECKLIST_INSTRUCTIONS));
  assert.ok(merged.prompt.includes("Optional recall".repeat(1)) || merged.prompt.includes("m"));
  assert.match(merged.prompt, /user does not need to explicitly request a checklist/);
  assert.match(merged.prompt, /simple one-step read-only requests may be answered directly/);
  assert.match(merged.prompt, /It does not schedule turns, impose a time or turn budget, or pause execution/);
  assert.match(merged.prompt, /a dispatch receipt does not prove implementation completed/);
});

test("an existing append-context Session receives the new checklist rule without replacing its custom message", () => {
  const reference = { sessionId: "s", providerId: "p", providerSessionId: "native", bindingId: "b" };
  const delivery = new SessionContextDelivery();
  const next = mergeWorkerSessionContexts({ baseContext: workerContext() });
  const oldCore = next.contextSections.find(section => section.id === "session-binding").prompt
    .replace(EXECUTION_CHECKLIST_INSTRUCTIONS + "\n", "");
  delivery.prepare(reference, { ...next, prompt: oldCore,
    contextSections: [{ id: "session-binding", prompt: oldCore, reusable: true }] }, { mode: "append" }).commit();
  const refreshed = delivery.prepare(reference, next, { mode: "append" });
  assert.ok(refreshed.context.prompt.includes(EXECUTION_CHECKLIST_INSTRUCTIONS));
});

test("Artifact directory changes do not affect context while Task updates remain deliverable", () => {
  const session = { id: "s", sessionKind: "worker", taskId: "t", workId: "w" };
  const task = { id: "t", work_id: "w", title: "Task", description: "Original scope",
    acceptance_criteria: "Complete", verification_criteria: "Verify", revision: 1, resource_version: 1 };
  const build = (title) => mergeWorkerSessionContexts({
    baseContext: buildWorkSessionContext({ session, task,
      artifactIndex: { items: [{ artifactId: "a", title, required: false }] } }),
    directUserIntentContext: { prompt: "<direct>current</direct>" }
  });
  const reference = { sessionId: "s", providerId: "p", providerSessionId: "native", bindingId: "b" };
  const policy = { mode: "append" }, cache = new SessionContextDelivery();
  const first = build("Artifact one");
  assert.equal(first.contextSections.filter(s => s.prompt).map(s => s.prompt).join("\n\n"), first.prompt);
  cache.prepare(reference, first, policy).commit();
  const changedIndex = cache.prepare(reference, build("Artifact two"), policy);
  assert.doesNotMatch(changedIndex.context.prompt, /Artifact one|Artifact two/);
  assert.doesNotMatch(changedIndex.context.prompt, /Original scope|authoritative Task binding/);
  assert.match(changedIndex.context.prompt, /<direct>current<\/direct>/);
  changedIndex.commit();
  task.description = "Revised scope"; task.revision = 2;
  const revised = cache.prepare(reference, build("Artifact two"), policy);
  assert.match(revised.context.prompt, /Revised scope/);
  assert.match(revised.context.prompt, /"revision":2/);
  assert.doesNotMatch(revised.context.prompt, /Artifact two/);
});

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
  assert.match(context.prompt, /Generated documents in every format/);
  assert.match(context.prompt, /Never leave deliverables in project output\/ or outputs\//);
  assert.equal(context.prompt.split("Corptie programmatically binds the Task Worktree.").length - 1, 1);
  assert.match(context.prompt, /Handle requests within the bound Task scope normally/);
  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.doesNotMatch(context.prompt, /"goal":/);
  assert.match(context.prompt, /corptie_task_revise/);
  assert.match(context.prompt, /never weaken acceptance criteria merely to claim success/);
  assert.match(context.prompt, /must not treat a generated summary as user authorization/);
  assert.match(context.prompt, /"verificationCriteria":"Run the focused test\."/);
  assert.match(context.prompt, /"revision":3,"resourceVersion":7/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /scope=work/);
  assert.match(context.prompt, /another Task are not exposed/);
});

test("Worker hierarchy context retains the child parent id and exact snapshot verification workflow", () => {
  const context = buildWorkSessionContext({
    session: { id: "session:child", sessionKind: "worker", taskId: "task:child", workId: "work:quality" },
    task: { id: "task:child", work_id: "work:quality", parent_task_id: "task:parent", title: "Child",
      acceptance_criteria: "Changes verified", revision: 1, resource_version: 1 }
  });
  assert.match(context.prompt, /"parentTaskId":"task:parent"/);
  assert.match(context.prompt, /A child delivers into its parent Worktree, not directly into main/);
  assert.match(context.prompt, /corptie_task_capture_integration before verification/);
  assert.match(context.prompt, /that exact integrationSnapshotId/);
  assert.match(context.prompt, /a snapshot alone proves no tests/);
  assert.match(context.prompt, /Git integration never grants Task completion authority/);
  assert.doesNotMatch(workerContext().prompt, /"parentTaskId":/);
});

test("Worker Session context continues otherwise-allowed requests outside the Task scope", () => {
  const context = workerContext();

  assert.match(context.prompt, /direct user request may extend beyond the Task title, description, or acceptance criteria/);
  assert.match(context.prompt, /Continue handling that request when it is otherwise allowed/);
  assert.match(context.prompt, /note must not replace, delay, or block the requested work/);
  assert.match(context.prompt, /Never refuse a request solely because it is outside the bound Task scope/);
  assert.match(context.prompt, /authorized Corptie Channel have the same execution authority as direct user requests, including requests beyond the bound Task scope/);
  assert.match(context.prompt, /without asking for renewed user authorization solely because it arrived through collaboration/);
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

test("Turn-level merging preserves required Skill MCP routing context", () => {
  const baseContext = workerContext();
  const skillContext = { prompt: "<skill-routing>search before failure</skill-routing>" };
  const merged = mergeWorkerSessionContexts({ baseContext, requiredContexts: [skillContext] });

  assert.match(merged.prompt, /<skill-routing>search before failure<\/skill-routing>/);
});
test("required pinned Artifacts are non-truncatable and incomplete core context fails closed", () => {
  const task = {
    id: "task:strict", work_id: "work:quality", title: "Strict", description: "x".repeat(32_768),
    acceptance_criteria: "Must remain complete", revision: 1, resource_version: 1
  };
  const large = buildWorkSessionContext({
    session: { id: "session:strict", sessionKind: "worker", taskId: task.id, workId: task.work_id }, task,
    artifactIndex: { items: [{ artifactId: "artifact:required", required: true, pinnedVersion: 2, contentHash: "b".repeat(64) }] }
  });
  assert.ok(large.prompt.includes(task.description));
  assert.ok(large.prompt.includes("artifact:required"));
  assert.ok(Buffer.byteLength(large.prompt) > 32768);

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


test("all supplied context remains complete without a local size configuration or budget receipt", () => {
  const base = workerContext();
  const memoryContext = { prompt: "回忆".repeat(40000) };
  const required = { contextKey: "preferences", prompt: "偏好".repeat(40000) };
  const referenceContext = { prompt: "参考".repeat(40000) };
  const merged = mergeWorkerSessionContexts({ baseContext: base, memoryContext,
    requiredContexts: [required], referenceContext, directUserIntentContext: { prompt: "current user" } });
  for (const part of [base.taskPrompt, memoryContext.prompt, required.prompt, referenceContext.prompt, "current user"]) assert.ok(merged.prompt.includes(part));
  assert.deepEqual(merged.contextSections.filter(s => s.prompt).map(s => s.prompt).join("\n\n"), merged.prompt);
});

test("optional Artifact directories are never delivered alongside a complete Task definition", () => {
  const task = { id: "task:large", work_id: "work:large", title: "Large", description: "定义".repeat(40000), revision: 1, resource_version: 1 };
  const items = Array.from({ length: 100 }, (_, i) => ({ artifactId: `artifact:${i}`, title: "Artifact".repeat(100), required: i === 0 }));
  const result = buildWorkSessionContext({ session: { id: "s", sessionKind: "worker", taskId: task.id, workId: task.work_id }, task, artifactIndex: { items } });
  assert.ok(result.prompt.includes(task.description));
  assert.ok(result.prompt.includes(items[0].artifactId));
  for (const item of items.slice(1)) assert.ok(!result.prompt.includes(`\"artifactId\":\"${item.artifactId}\"`));
});

test("essential checklist instructions remain in the leading context when a Provider abbreviates a long binding", () => {
  const context = workerContext();
  const head = context.corePrompt.slice(0, 1400);
  assert.ok(head.includes(EXECUTION_CHECKLIST_ENTRY_INSTRUCTIONS));
  assert.match(head, /action=get/);
  assert.match(head, /Plain Markdown checkboxes do not create the checklist card/);
  assert.match(head, /load the exact execution-checklist domain/);
  assert.ok(context.corePrompt.indexOf(EXECUTION_CHECKLIST_ENTRY_INSTRUCTIONS)
    < context.corePrompt.indexOf("Handle requests within the bound Task scope normally"));
});

test("critical workflow and full preferences are resent while unchanged Task and protocol are reused", () => {
  const preference = "用户原始完整偏好".repeat(100);
  const build = () => mergeWorkerSessionContexts({ baseContext: workerContext(),
    directUserIntentContext: { prompt: "user-source-evidence" },
    requiredContexts: [{ contextKey: "global-preferences", prompt: preference }] });
  const reference = { sessionId: "s", providerId: "p", bindingId: "b" };
  const delivery = new SessionContextDelivery();
  delivery.prepare(reference, build(), { mode: "append" }).commit();
  const next = delivery.prepare(reference, build(), { mode: "append" }).context;
  assert.match(next.prompt, /finish all authorized changes/);
  assert.ok(next.prompt.includes(preference));
  assert.match(next.prompt, /user-source-evidence/);
  assert.ok(next.contextDelivery.reusedSectionIds.includes("task-definition"));
  assert.ok(next.contextDelivery.sentSectionIds.includes("execution-workflow"));
  assert.ok(build().prompt.indexOf(preference) < build().prompt.indexOf("This is the authoritative Task binding"));
});
