import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { ProjectCodeSnapshotApplicationService } from "../src/project-code/projectCodeSnapshotApplicationService.mjs";
import { projectCodeSnapshotDynamicTools, callProjectCodeSnapshotDynamicTool } from "../src/project-code/projectCodeSnapshotDynamicTools.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("production composition invokes and persists one authoritative current-Worktree Snapshot", async () => {
  const fixture = await createProjectCodeFixture();
  const persisted = [];
  const logical = {
    activeBinding: {
      bindingId: fixture.binding.providerBindingId,
      worktreeId: fixture.binding.worktreeId,
      boundCwd: fixture.binding.canonicalWorktreePath
    }
  };
  const store = {
    assertLogicalWorkSessionBinding: () => ({ ...fixture.sessionContext, sessionId: "session:test" }),
    getLogicalSession: () => logical,
    getSession: () => ({ id: "session:test", sessionKind: "worker" }),
    getWorkItem: () => ({ id: fixture.sessionContext.workItemId }),
    putProjectCodeReceipt: (record) => persisted.push(structuredClone(record))
  };
  const service = new ProjectCodeSnapshotApplicationService({
    store,
    startupReceipts: { require: () => fixture.startupReceipt },
    snapshotBuilder: new RepositorySourceSnapshotBuilder()
  });
  const catalog = new HostToolCatalog([{
    id: "project-code-snapshot",
    tools: projectCodeSnapshotDynamicTools,
    authorize: ({ metadata }) => metadata?.sessionKind === "worker",
    execute: (input) => callProjectCodeSnapshotDynamicTool(service, input)
  }]);
  try {
    const output = await catalog.execute({
      tool: "corptie_project_code_snapshot",
      metadata: { ...fixture.sessionContext, sessionKind: "worker" }
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].receiptId, output.receipt.receiptId);
    assert.equal(persisted[0].sourceFingerprint, output.receipt.sourceFingerprint);
    assert.equal(output.receipt.worktreeId, fixture.binding.worktreeId);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
