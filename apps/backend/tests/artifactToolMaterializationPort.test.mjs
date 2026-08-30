import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ArtifactDomainRequirements } from "../src/application/artifactDomainRequirements.mjs";
import { callArtifactDynamicTool } from "../src/application/artifactDynamicTools.mjs";
import {
  composeArtifactToolMaterializationPort,
  ToolMaterializationPort
} from "../src/application/toolMaterializationPort.mjs";

const appliedReceipt = Object.freeze({
  appliedDomains: ["artifacts"],
  receiptId: "receipt:tool-host-applied"
});

test("ToolMaterializationPort preserves the two approved positional signatures on Allowed results", async () => {
  const calls = [];
  const port = new ToolMaterializationPort({
    ensureDomainsApplied: async (...args) => { calls.push(["ensure", ...args]); return appliedReceipt; },
    assertCanonicalToolApplied: async (...args) => { calls.push(["assert", ...args]); return true; }
  });
  const boundary = Object.freeze({ turnExecutionId: "turn:1", purpose: "session" });

  assert.equal(await port.ensureDomainsApplied("logical:1", ["artifacts"], boundary), appliedReceipt);
  assert.equal(await port.assertCanonicalToolApplied("logical:1", "corptie_artifact_get"), true);
  assert.deepEqual(calls, [
    ["ensure", "logical:1", ["artifacts"], boundary],
    ["assert", "logical:1", "corptie_artifact_get"]
  ]);
});

test("ToolMaterializationPort thinly preserves Blocked and Error identities", async () => {
  for (const code of ["TOOL_DOMAIN_FORBIDDEN", "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN"]) {
    const hostOutcome = Object.assign(new Error(code), { code, statusCode: code === "TOOL_DOMAIN_FORBIDDEN" ? 403 : 503 });
    const port = new ToolMaterializationPort({
      ensureDomainsApplied: async () => { throw hostOutcome; },
      assertCanonicalToolApplied: async () => { throw hostOutcome; }
    });
    await assert.rejects(
      port.ensureDomainsApplied("logical:1", ["artifacts"], { turnExecutionId: "turn:1" }),
      (error) => error === hostOutcome
    );
    await assert.rejects(
      port.assertCanonicalToolApplied("logical:1", "corptie_artifact_get"),
      (error) => error === hostOutcome
    );
  }
});

test("ToolMaterializationPort rejects an Allowed receipt that does not apply the requested domain", async () => {
  const port = new ToolMaterializationPort({
    ensureDomainsApplied: async () => ({ appliedDomains: [] }),
    assertCanonicalToolApplied: async () => true
  });
  await assert.rejects(
    port.ensureDomainsApplied("logical:1", ["artifacts"], { turnExecutionId: "turn:1" }),
    { code: "PROVIDER_TOOL_RECEIPT_INVALID" }
  );
});

test("production composition fails closed when ToolHostService lacks the approved Port", async () => {
  const port = composeArtifactToolMaterializationPort({});
  await assert.rejects(
    port.ensureDomainsApplied("logical:1", ["artifacts"], { turnExecutionId: "turn:1" }),
    { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", statusCode: 503 }
  );
  await assert.rejects(
    port.assertCanonicalToolApplied("logical:1", "corptie_artifact_get"),
    { code: "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN", statusCode: 503 }
  );
});

test("production composition forwards without translating the approved Tool Host methods", async () => {
  const calls = [];
  const host = {
    ensureDomainsApplied(...args) { calls.push(["ensure", this === host, ...args]); return appliedReceipt; },
    assertCanonicalToolApplied(...args) { calls.push(["assert", this === host, ...args]); return true; }
  };
  const port = composeArtifactToolMaterializationPort(host);
  const boundary = { turnExecutionId: "turn:composition" };
  await port.ensureDomainsApplied("logical:composition", ["artifacts"], boundary);
  await port.assertCanonicalToolApplied("logical:composition", "corptie_artifact_list");
  assert.deepEqual(calls, [
    ["ensure", true, "logical:composition", ["artifacts"], boundary],
    ["assert", true, "logical:composition", "corptie_artifact_list"]
  ]);
});

test("Artifact dynamic tools assert the canonical name before dispatch", async () => {
  const asserted = [];
  let dispatched = false;
  const port = new ToolMaterializationPort({
    ensureDomainsApplied: async () => appliedReceipt,
    assertCanonicalToolApplied: async (...args) => { asserted.push(args); return true; }
  });
  await callArtifactDynamicTool({
    list: () => { dispatched = true; return []; }
  }, {
    tool: "corptie_artifact_list",
    actorId: "agent:1",
    metadata: {
      logicalSessionId: "logical:1", sessionId: "product-session:1",
      sessionKind: "worker", objectiveId: "objective:1"
    },
    arguments: {}
  }, { toolMaterializationPort: port });
  assert.equal(dispatched, true);
  assert.deepEqual(asserted, [["logical:1", "corptie_artifact_list"]]);
});

test("Artifact public materialization boundary contains no binding, catalog, or Provider-name branches", async () => {
  const source = await readFile(new URL("../src/application/toolMaterializationPort.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /providerBindingId|catalogVersion/);
  assert.doesNotMatch(source, /\b(?:codex|claude|openclacky)\b/i);
});

test("Artifact role requirements keep Worker eager and Objective Chat on-demand", () => {
  const worker = ArtifactDomainRequirements.forSessionRole({ sessionKind: "worker" });
  const objective = ArtifactDomainRequirements.forSessionRole({
    sessionKind: "objectiveChat", roleCapabilities: ["artifact:manage"]
  });
  assert.deepEqual(worker.requiredBeforeFirstTurn.map((item) => item.domainId), ["artifacts"]);
  assert.deepEqual(objective.requiredBeforeFirstTurn, []);
  assert.deepEqual(objective.onDemandDomains.map((item) => item.domainId), ["artifacts"]);
});
