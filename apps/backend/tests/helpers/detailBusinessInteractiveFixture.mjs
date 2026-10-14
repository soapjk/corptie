import { projectDetailBusinessRich } from "../../src/application/detailBusinessRichProjection.mjs";
import { DETAIL_COMPONENTS_CATALOG, DETAIL_COMPONENT_CAPABILITIES } from "../../src/application/detailV2Catalog.mjs";
import { diffDetailV2, applyDetailV2, canonicalDetailV2 } from "../../src/application/detailSyncV2.mjs";

// Deterministic producer fixture, not a product route or a mutation executor.
export function detailBusinessInteractiveFixture() {
  const profile = { catalog: DETAIL_COMPONENTS_CATALOG, clientCapabilities: [...DETAIL_COMPONENT_CAPABILITIES] };
  const scope = { session: { id: "session:interactive", sessionKind: "worker" }, logicalSessionId: "session:interactive",
    task: { id: "task:interactive", revision: 1, title: "Interactive Detail", description: "Producer contract", acceptance_criteria: "", verification_criteria: "" } };
  const action = (id, operation, revision) => ({ id, operation, kind: "command", available: true,
    label: { fallback: id === "save" ? "保存" : "删除" }, target: { resourceType: "memory", id: "memory:interactive" },
    expectedResourceRevision: revision, confirmation: id === "save" ? "none" : "destructive" });
  const build = (previous, next) => projectDetailBusinessRich(scope, {
    references: { state: "ready", data: { items: [{ resource: { resourceType: "reference", id: next ? "reference:second" : "reference:first" },
      displayName: next ? "Second page" : "First page", status: "available", targetType: "webURL", enabled: true }], hasMore: !next } }
  }, { profile, generation: "interactive-generation", previous, navigation: true, editors: true,
    pages: { "business-references": { nextCursor: next ? null : "opaque-lease-interactive" } },
    operations: [{ id: "memory-editor-interactive", kind: "memory", fields: {
      title: "Memory", state: "可编辑", content: next ? "Saved content" : "Original content"
    }, actions: { save: action("save", "memory.update", next ? "revision-2" : "revision-1"),
      remove: action("remove", "memory.delete", next ? "revision-2" : "revision-1") } }] });
  const snapshot = build(null, false), expectedState = build(snapshot, true), commit = diffDetailV2(snapshot, expectedState, profile);
  if (canonicalDetailV2(applyDetailV2(snapshot, commit, profile)) !== canonicalDetailV2(expectedState)) throw new Error("interactive fixture does not converge");
  return { ...profile, snapshot, commit, expectedState };
}
if (process.argv[1]?.endsWith("detailBusinessInteractiveFixture.mjs")) console.log(JSON.stringify(detailBusinessInteractiveFixture()));
