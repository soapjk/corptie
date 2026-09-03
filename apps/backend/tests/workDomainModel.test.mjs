import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-domain-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "settings.json")
  });
  await store.initialize();
  const agent = store.createAgent({
    id: "agent:worker",
    name: "Worker",
    role: "independentContributor"
  });
  return { directory, store, agent, service: new WorkApplicationService({ store }) };
}

test("Work owns exactly one managed Workspace and requires a contributor", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.service.createWork({ name: "No owner" }),
      { code: "WORK_CONTRIBUTOR_REQUIRED", field: "contributorAgentIds" }
    );

    const work = f.service.createWork({
      name: "Quarterly report",
      profile: "office",
      contributorAgentIds: [f.agent.agentId]
    });
    assert.match(work.workspaceId, /^workspace:/);
    assert.equal(work.profile, "office");
    assert.equal(work.status, "active");
    assert.equal(work.primaryAgentId, f.agent.agentId);
    assert.equal("workspaceIds" in work, false);
    assert.equal("targetDate" in work, false);

    const workspace = f.store.getWorkspace(work.workspaceId);
    assert.deepEqual(f.store.listWorkContributors(work.id).map((item) => ({
      agentId: item.agentId,
      isPrimary: item.isPrimary
    })), [{ agentId: f.agent.agentId, isPrimary: true }]);
    assert.equal(
      f.store.selectAll("PRAGMA table_info(works)").some((column) => column.name === "contributor_agent_ids_json"),
      false
    );
    assert.equal(
      f.store.selectAll("PRAGMA table_info(tasks)").some((column) => column.name === "main_workspace_id"),
      false
    );
    assert.deepEqual(
      { kind: workspace.kind, ownership: workspace.ownership, status: workspace.status },
      { kind: "managedLocal", ownership: "corptieManaged", status: "pending" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Workspace binding is unique and immutable after Work creation", async () => {
  const f = await fixture();
  try {
    const workspace = f.store.createWorkspace({
      workspaceId: "workspace:linked",
      kind: "linkedLocal",
      ownership: "userManaged",
      rootPath: f.directory
    });
    const work = f.service.createWork({
      name: "Linked work",
      workspaceId: workspace.workspaceId,
      contributorAgentIds: [f.agent.agentId]
    });
    assert.equal(work.workspaceId, workspace.workspaceId);
    assert.throws(
      () => f.service.createWork({
        name: "Second owner",
        workspaceId: workspace.workspaceId,
        contributorAgentIds: [f.agent.agentId]
      }),
      { code: "WORKSPACE_ALREADY_BOUND", field: "workspaceId" }
    );
    assert.throws(
      () => f.service.updateWork(work.id, { workspaceId: "workspace:other" }),
      { code: "UNKNOWN_PATCH_FIELD", field: "workspaceId" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
