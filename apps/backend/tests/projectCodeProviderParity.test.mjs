import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("Codex, Claude and OpenClacky consume the same provider-neutral Snapshot/Search contract", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const outputs = [];
    for (const providerId of ["codex-app-server", "claude-agent-sdk", "openclacky"]) {
      const service = new ProjectCodeSearchService({ snapshotBuilder: builder });
      const result = await service.search({ snapshot, sessionContext: { ...fixture.sessionContext, providerId },
        searchScenarioId: `provider-${providerId}`, query: "exactNeedle", mode: "exact" });
      outputs.push(result.results.map(({ path, line, kind, snippet }) => ({ path, line, kind, snippet })));
      assert.equal(Object.hasOwn(result.receipt, "providerId"), false);
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(outputs[1], outputs[2]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
