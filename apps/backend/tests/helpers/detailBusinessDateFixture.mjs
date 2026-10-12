import { createDetailBusinessReadPorts } from "../../src/application/detailBusinessReadPorts.mjs";
import { DetailBusinessReadCache } from "../../src/application/detailBusinessReadCache.mjs";
import { projectDetailBusinessRich, DETAIL_RICH_BUSINESS_MODULES } from "../../src/application/detailBusinessRichProjection.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../../src/application/detailV2Catalog.mjs";
import { diffDetailV2 } from "../../src/application/detailSyncV2.mjs";

/** Real business adapters/producer with deterministic fake source services.
 * No live data, clock, host timezone, credentials, actions or network sources. */
export async function detailBusinessDateFixture() {
  const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
  const scope = { session: { id: "date-session", sessionKind: "worker", external: { currentModel: "fixture-model" } },
    logicalSessionId: "logical:business-date-fixture", task: { id: "date-task", title: "日期业务", description: "只读日期与列表验证" },
    work: { id: "date-work", name: "Date fixture Work" } };
  const timestamps = [null, "2026-03-08T01:59:59-08:00", "2026-03-08T03:00:00-07:00", "2026-11-01T01:30:00-07:00",
    "2026-11-01T01:30:00-08:00", "2026-10-11T12:00:00+08:00", "2026-10-11T04:00:00Z", "2024-02-29T23:59:59.123+05:30"];
  const rows = Array.from({ length: 21 }, (_, i) => ({ taskId: `schedule:${i}`, name: `计划 ${i}`, status: "active", scheduleType: "once",
    nextRunAt: timestamps[i % timestamps.length], runAt: i === 0 ? null : "2026-10-10T04:00:00Z", timezone: "America/Los_Angeles",
    message: "do-not-export-secret" }));
  const ports = createDetailBusinessReadPorts({
    store: { countArtifactsReferencedByTask: () => 1, listMemoryPage: () => ({ items: [], hasMore: false }),
      listMemoryRecallAudit: () => [{ id: "recall", phase: "planning", mode: "automatic", reason: "eligible",
        createdAt: "2026-10-11T12:00:00+08:00", selectedIds: [], candidateIds: [], diagnostics: { injection: { status: "injected" } } }] },
    references: { list: () => [{ referenceId: "reference", targetType: "webURL", displayName: "只读引用", locator: "https://do-not-export.invalid" }] },
    artifacts: { listForTask: () => [{ artifactId: "artifact", title: "固定 Artifact", currentVersion: 3,
      references: [{ referenceId: "artifact-reference", taskId: "date-task", required: true, versionPolicy: "fixed", pinnedVersion: 2,
        pinnedHash: "a".repeat(64), pendingVersion: 3, pendingHash: "b".repeat(64) }], storageKey: "/do-not-export" }] },
    schedules: { list: () => rows }, providerRegistry: { descriptors: () => [{ id: "fixture-provider", displayName: "Provider" }], supports: () => true },
    observability: { latestSummary: () => ({ identity: { logicalSessionId: scope.logicalSessionId, turnExecutionId: "turn" },
      wall: { totalMs: 12 }, completeness: { state: "partial" } }) },
    readWorktree: async () => ({ attached: true, repositoryId: "repository", worktree: { worktreeId: "worktree", branchName: "fixture", path: "/do-not-export" } })
  });
  const reader = new DetailBusinessReadCache(ports);
  const identity = { principalId: "fixture-principal", accountId: "fixture-account", serverId: "fixture-server", sessionId: scope.logicalSessionId,
    catalogProfile: profile.catalog };
  const read = async () => {
    const results = {};
    for (const name of DETAIL_RICH_BUSINESS_MODULES) results[name] = await reader.read(scope, name, identity, { force: true });
    return results;
  };
  const options = { profile, generation: "business-date-fixture-v1" };
  const snapshot = projectDetailBusinessRich(scope, await read(), options);
  rows[0].nextRunAt = "2026-10-11T04:00:00Z";
  rows[1].runAt = null; // optional-field removal and native date re-preparation
  rows[4].nextRunAt = "2026-11-01T09:30:00Z"; // same instant, different original offset
  const expected = projectDetailBusinessRich(scope, await read(), { ...options, previous: snapshot });
  return { catalog: profile.catalog, clientCapabilities: profile.clientCapabilities, snapshot,
    commit: diffDetailV2(snapshot, expected, profile), expectedStateHash: expected.stateHash,
    expectedDateInstants: Object.fromEntries(timestamps.filter(Boolean).map(value => [value, new Date(value).toISOString()])) };
}
