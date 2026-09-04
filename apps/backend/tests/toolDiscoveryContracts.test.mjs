import assert from "node:assert/strict";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { artifactDynamicTools } from "../src/application/artifactDynamicTools.mjs";
import { memoryDynamicTools } from "../src/application/memoryDynamicTools.mjs";
import { skillDynamicTools } from "../src/application/skillDynamicTools.mjs";
import { taskAcceptanceDynamicTools } from "../src/application/taskAcceptanceDynamicTools.mjs";
import { scheduledSessionTaskDynamicTools } from "../src/application/scheduledSessionTaskDynamicTools.mjs";
import { collaborationDynamicTools } from "../src/collaboration/collaborationDynamicTools.mjs";
import { projectCodeDynamicTools } from "../src/project-code/projectCodeDynamicTools.mjs";
import { workspaceDynamicTools } from "../src/runtime/workspaceDynamicTools.mjs";
import { platformDynamicTools } from "../src/application/platformDynamicTools.mjs";
import { workChatDynamicTools } from "../src/application/workChatDynamicTools.mjs";

const domains = {
  artifacts: artifactDynamicTools,
  collaboration: collaborationDynamicTools,
  "task-acceptance": taskAcceptanceDynamicTools,
  "project-code": projectCodeDynamicTools,
  workspace: workspaceDynamicTools,
  memory: memoryDynamicTools,
  skills: skillDynamicTools,
  "scheduled-tasks": scheduledSessionTaskDynamicTools,
  platform: platformDynamicTools,
  "work-chat": workChatDynamicTools
};

function catalogFixture() {
  return new HostToolCatalog(Object.entries(domains).map(([id, tools]) => ({
    id,
    tools,
    execute: ({ arguments: args }) => args
  })));
}

test("all required deferred domains expose one recommended tool and self-contained machine contracts", async () => {
  const catalog = catalogFixture();
  const context = { actorId: "agent:test", metadata: { sessionKind: "worker", workId: "work:test", sessionId: "session:test" } };
  for (const [domainId, definitions] of Object.entries(domains)) {
    const contract = catalog.domainContract(context, domainId, {
      surface: "restricted_gateway",
      catalogVersion: catalog.snapshot().catalogVersion
    });
    assert.ok(contract, domainId);
    assert.equal(contract.tools.length, definitions.length, domainId);
    assert.equal(contract.tools.filter((tool) => tool.recommended).length, 1, domainId);
    assert.equal(contract.invocation.mode, "restricted_gateway", domainId);
    for (const tool of contract.tools) {
      assert.ok(tool.inputSchema && tool.fieldDescriptions && tool.constraints, tool.canonicalName);
      assert.ok(tool.minimalExample && typeof tool.minimalExample === "object", tool.canonicalName);
      await catalog.execute({ ...context, tool: tool.canonicalName, arguments: tool.minimalExample });
    }
  }
});

test("compatibility entry and field mappings are explicit while canonical Automation entry stays recommended", () => {
  const catalog = catalogFixture();
  const contract = catalog.domainContract({}, "scheduled-tasks");
  assert.equal(contract.recommendedTool, "corptie_automations_create");
  const legacy = contract.tools.find((tool) => tool.canonicalName === "corptie_scheduled_tasks_manage");
  assert.equal(legacy.stability, "compatibility");
  assert.equal(legacy.compatibility.fieldMappings.task_id, "automation_id");
  assert.match(legacy.compatibility.resultNormalization, /taskId/);
});

test("collaboration discovery recommends direct Channel open for an explicit Session alias", () => {
  const catalog = catalogFixture();
  const contract = catalog.domainContract({}, "collaboration");
  assert.equal(contract.recommendedTool, "corptie_collaboration_channel_open");
  assert.equal(contract.tools[0].canonicalName, "corptie_collaboration_channel_open");
  const open = contract.tools[0];
  assert.match(open.description, /without pre-discovery/);
  assert.match(open.inputSchema.properties.recipient_session_name.description, /optionally prefixed with @/);
  const agents = contract.tools.find((tool) => tool.canonicalName === "corptie_agents_discover");
  assert.match(agents.description, /Do not use this tool to resolve an @Session name/);
});

test("Automation discovery contract explains long-process wakeup without foreground polling", () => {
  const catalog = catalogFixture();
  const contract = catalog.domainContract({}, "scheduled-tasks");
  const create = contract.tools.find((tool) => tool.canonicalName === "corptie_automations_create");
  assert.match(create.description, /background/);
  assert.match(create.description, /processExit or condition/);
  assert.match(create.description, /never starts or restarts/);
  assert.match(create.inputSchema.properties.process.properties.expected_start_time.description, /PID reuse/);
  assert.match(create.inputSchema.properties.expires_after_seconds.description, /exactly one expiration field/);
});

test("discovery contracts distinguish read-only context from mutating operations", () => {
  const catalog = catalogFixture();
  assert.equal(catalog.domainContract({}, "work-chat").tools
    .find((tool) => tool.canonicalName === "corptie_work_context").sideEffect, false);
  assert.equal(catalog.domainContract({}, "workspace").tools
    .find((tool) => tool.canonicalName === "corptie_create_worktree").sideEffect, true);
});

test("schema validation aggregates missing, enum, range, combination, and unknown-field issues", async () => {
  const catalog = catalogFixture();
  await assert.rejects(() => catalog.execute({
    tool: "corptie_automations_create",
    arguments: {
      name: "",
      schedule_type: "unsupported",
      expires_at: "2099-01-01T00:00:00.000Z",
      expires_after_seconds: 0,
      unexpected: true
    }
  }), (error) => {
    assert.equal(error.code, "TOOL_ARGUMENT_SCHEMA_INVALID");
    const keywords = new Set(error.issues.map((issue) => issue.keyword));
    const paths = new Set(error.issues.map((issue) => issue.path));
    assert.ok(keywords.has("minLength"));
    assert.ok(keywords.has("enum"));
    assert.ok(keywords.has("minimum"));
    assert.ok(keywords.has("oneOf"));
    assert.ok(keywords.has("additionalProperties"));
    assert.ok(paths.has("$.name"));
    assert.ok(paths.has("$.schedule_type"));
    assert.ok(paths.has("$.expires_after_seconds"));
    assert.ok(paths.has("$.unexpected"));
    return true;
  });
});
