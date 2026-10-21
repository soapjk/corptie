import { presentTaskAcceptance } from "./taskAcceptance.mjs";
import { taskHierarchyError } from "../store/repositories/taskHierarchyRepository.mjs";

// Shared by all Providers; adapters never own Git or integration acceptance.
export const taskHierarchyCapabilities = Object.freeze({
  version:1, maxDepth:1, createChild:true, worktreeOperations:true, integrationAcceptance:true
});

export function readTaskHierarchyPage(store, workId, query) {
  const allowed = new Set(["parentTaskId","limit","cursor","includeCompleted","includeArchived","q"]);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) {
    throw taskHierarchyError("INVALID_QUERY", "Invalid hierarchy query", 400);
  }
  for (const key of ["includeCompleted","includeArchived"]) {
    if (query.has(key) && !["true","false"].includes(query.get(key))) throw taskHierarchyError("INVALID_QUERY", "Expected boolean filter", 400);
  }
  const limit = query.has("limit") ? Number(query.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.get("cursor")?.length ?? 0) > 2048) throw taskHierarchyError("INVALID_QUERY", "Invalid page bounds", 400);
  const parent = query.get("parentTaskId") ?? "root";
  if (parent !== "root" && !/^task:[^\s]+$/u.test(parent)) throw taskHierarchyError("INVALID_QUERY", "Invalid parent", 400);
  const page = store.listTaskHierarchyPage({workId,parentTaskId:parent === "root" ? null : parent,
    query:query.get("q") ?? "",limit,cursor:query.get("cursor"),
    includeCompleted:query.get("includeCompleted") !== "false",includeArchived:query.get("includeArchived") === "true"});
  const summaries = store.hierarchySummaries([...page.items,...page.ancestors].map(t=>t.id));
  const wakeIDs = new Set(store.listTaskIdsWithPendingScheduledWake());
  const project = task => presentTaskAcceptance(task,{hierarchy:summaries.get(task.id),hasPendingScheduledWake:wakeIDs.has(task.id)});
  const {items,ancestors,...rest} = page;
  return {...rest,tasks:items.map(project),ancestors:ancestors.map(project),taskHierarchyCapabilities};
}
