import assert from "node:assert/strict";
import test from "node:test";

import { requiredToolDomainsForSession } from "../src/application/sessionToolDomainRequirements.mjs";

test("recommended project-code is required for every Provider-neutral Worker Session", () => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky", "future-provider"]) {
    assert.deepEqual(requiredToolDomainsForSession({
      sessionKind: "worker",
      providerId
    }, { projectCodeRecommendationEnabled: true }), ["artifacts", "project-code"]);
  }
});

test("project-code is not forced before its benchmark recommendation gate passes", () => {
  assert.deepEqual(requiredToolDomainsForSession({
    sessionKind: "worker"
  }, { projectCodeRecommendationEnabled: false }), ["artifacts"]);
});

test("non-Worker Sessions never receive repository-scoped project-code authority", () => {
  assert.deepEqual(requiredToolDomainsForSession({
    sessionKind: "workChat",
    roleCapabilities: ["artifact:manage"]
  }, { projectCodeRecommendationEnabled: true }), []);
  assert.deepEqual(requiredToolDomainsForSession({
    sessionKind: "assistantChat"
  }, { projectCodeRecommendationEnabled: true }), []);
});
