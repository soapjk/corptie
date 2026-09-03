import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ArtifactDomainRequirements } from "../src/application/artifactDomainRequirements.mjs";
import { callArtifactDynamicTool } from "../src/application/artifactDynamicTools.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";

test("production ToolHostService fails closed when the approved Port is unavailable", async () => {
  const service = new ToolHostService({ registry: {}, catalog: {} });
  await assert.rejects(
    async () => service.ensureDomainsApplied("logical:missing", ["artifacts"], { turnExecutionId: "turn:missing" }),
    { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", statusCode: 503 }
  );
  await assert.rejects(
    async () => service.assertCanonicalToolApplied("logical:missing", "corptie_artifact_get"),
    { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", statusCode: 503 }
  );
});

test("Artifact dynamic tools assert the canonical name before dispatch", async () => {
  const asserted = [];
  let dispatched = false;
  const port = {
    assertCanonicalToolApplied: async (...args) => { asserted.push(args); return true; }
  };
  await callArtifactDynamicTool({
    list: () => { dispatched = true; return []; }
  }, {
    tool: "corptie_artifact_list",
    actorId: "agent:1",
    metadata: {
      logicalSessionId: "logical:1", sessionId: "product-session:1",
      sessionKind: "worker", workId: "work:1"
    },
    arguments: {}
  }, { toolMaterializationPort: port });
  assert.equal(dispatched, true);
  assert.deepEqual(asserted, [["logical:1", "corptie_artifact_list"]]);
});

test("Artifact public materialization boundary contains no binding, catalog, or Provider-name branches", async () => {
  const [dynamicTools, sessionService] = await Promise.all([
    readFile(new URL("../src/application/artifactDynamicTools.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/agent-provider/sessionApplicationService.mjs", import.meta.url), "utf8")
  ]);
  assert.match(dynamicTools, /assertCanonicalToolApplied\(logicalSessionId, input\.tool\)/);
  assert.match(sessionService, /ensureDomainsApplied\(logicalSessionId, domains, \{/);
  assert.doesNotMatch(dynamicTools, /assertCanonicalToolApplied\([^\n]*providerBindingId/);
  assert.doesNotMatch(sessionService, /ensureDomainsApplied\([^\n]*providerBindingId/);
  assert.doesNotMatch(`${dynamicTools}\n${sessionService}`, /\b(?:codex|claude|openclacky)\b/i);
});

test("Artifact role requirements keep Worker eager and Work Chat on-demand", () => {
  const worker = ArtifactDomainRequirements.forSessionRole({ sessionKind: "worker" });
  const work = ArtifactDomainRequirements.forSessionRole({
    sessionKind: "workChat", roleCapabilities: ["artifact:manage"]
  });
  assert.deepEqual(worker.requiredBeforeFirstTurn.map((item) => item.domainId), ["artifacts"]);
  assert.deepEqual(work.requiredBeforeFirstTurn, []);
  assert.deepEqual(work.onDemandDomains.map((item) => item.domainId), ["artifacts"]);
});
