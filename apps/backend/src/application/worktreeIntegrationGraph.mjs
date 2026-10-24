import { TaskIntegrationAcceptanceService } from "./taskIntegrationAcceptanceService.mjs";
import { realpath } from "node:fs/promises";

const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

// Exact-path tracking consent follows only the reviewed, forward execution
// edges. This never expands to arbitrary worktrees or another repository.
export async function integrationTrackingTargets(job, sourcePath) {
  const graph = job?.details?.plan?.orchestration;
  const state = job?.details?.graphExecution;
  const items = state?.reviewedItems ?? [];
  if (!graph) return [];
  const paths = await Promise.all(items.map(item => realpath(item.path).catch(() => null)));
  const canonicalSource = await realpath(sourcePath);
  const source = items.find((item, index) => paths[index] === canonicalSource);
  if (!source) return [];
  const reachable = new Set([source.worktreeId]);
  for (const step of graph.steps.slice(state.phase === "committing" ? 0 : state.index)) {
    if (step.sourceWorktreeIds.some(id => reachable.has(id))) reachable.add(step.targetWorktreeId);
  }
  return items.flatMap((item, index) => reachable.has(item.worktreeId) && paths[index] && paths[index] !== canonicalSource ? [paths[index]] : []);
}

// A server-built, reviewed dependency graph. Never accept scopes/steps supplied
// by a client. Execution reuses the existing single-Job Git/conflict machinery.
export class WorktreeIntegrationGraph {
  constructor({ store, hierarchy }) {
    this.store = store;
    this.hierarchy = hierarchy;
    this.acceptance = new TaskIntegrationAcceptanceService({ store });
  }

  async build(inspection, requestedIds) {
    const decorated = await this.hierarchy.decorateInspection(inspection);
    const byId = new Map(decorated.worktrees.map(tree => [tree.worktreeId, tree]));
    const main = byId.get(inspection.mainWorktreeId);
    if (!main) throw fail("WORKTREE_NOT_FOUND", "The main Worktree is unavailable.");
    const requested = [...new Set(requestedIds)].sort();
    const included = new Set();
    const groups = new Map();
    const ordinary = [];
    for (const id of requested) {
      const tree = byId.get(id);
      if (!tree || tree.isMain) throw fail("WORKTREE_NOT_FOUND", `Invalid source Worktree: ${id}.`);
      const h = tree.hierarchy;
      if (!h) { included.add(id); ordinary.push(id); continue; }
      if (groups.has(h.rootTaskId)) continue;
      const root = this.hierarchy.resolveTaskDelivery(h.rootTaskId, { allowAdoption: false });
      if (root.task.lifecycle_state === "done") throw fail("TASK_PARENT_UNAVAILABLE", "Reopen the completed parent before changing its integration code, or use its existing accepted publication action.");
      const parent = byId.get(root.binding.worktree_id);
      if (!parent || root.binding.repository_id !== inspection.repositoryId) throw fail("TASK_PARENT_INVALID", "The parent Worktree is unavailable.");
      const children = this.store.selectAll("SELECT id,work_id FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' ORDER BY id", [root.task.id]);
      const bindings = [root];
      for (const child of children) {
        const delivery = this.hierarchy.resolveTaskDelivery(child.id, { allowAdoption: false });
        if (child.work_id !== root.task.work_id || delivery.binding.repository_id !== inspection.repositoryId
          || !byId.has(delivery.binding.worktree_id)) throw fail("TASK_PARENT_INVALID", "A child delivery is missing or belongs to another repository.");
        bindings.push(delivery);
      }
      const scope = { version: 1, rootTaskId: root.task.id, expectedHierarchyRevision: root.task.hierarchy_revision,
        expectedBindingRevision: root.binding.binding_revision };
      const childIds = bindings.slice(1).map(value => value.binding.worktree_id);
      const group = { rootTaskId: root.task.id, parentWorktreeId: parent.worktreeId, childWorktreeIds: childIds, scope,
        bindings: bindings.map(value => ({ taskId: value.task.id, worktreeId: value.binding.worktree_id,
          bindingRevision: value.binding.binding_revision, parentTaskId: value.task.parent_task_id ?? null })) };
      groups.set(root.task.id, group);
      included.add(parent.worktreeId);
      childIds.forEach(value => included.add(value));
    }
    const steps = [];
    const add = step => steps.push({ id: `step:${steps.length + 1}`, dependsOn: steps.at(-1)?.id ?? null,
      sourceBranchNames: step.sourceWorktreeIds.map(id => byId.get(id)?.branchName ?? id),
      targetBranchName: byId.get(step.targetWorktreeId)?.branchName ?? step.targetWorktreeId, ...step });
    for (const group of [...groups.values()].sort((a, b) => a.rootTaskId.localeCompare(b.rootTaskId))) {
      if (group.childWorktreeIds.length) add({ kind: "merge_children", rootTaskId: group.rootTaskId,
        sourceWorktreeIds: group.childWorktreeIds, targetWorktreeId: group.parentWorktreeId });
      // Parent publication is ff-only. Bring the current main baseline into the
      // parent BEFORE assessing its exact integrated code, never after testing.
      add({ kind: "merge_main_into_parent", rootTaskId: group.rootTaskId,
        sourceWorktreeIds: [main.worktreeId], targetWorktreeId: group.parentWorktreeId });
      add({ kind: "acceptance", rootTaskId: group.rootTaskId, sourceWorktreeIds: [], targetWorktreeId: group.parentWorktreeId,
        acceptanceSessionId: this.store.getTask(group.rootTaskId)?.current_session_id ?? null });
      add({ kind: "promote_parent", rootTaskId: group.rootTaskId,
        sourceWorktreeIds: [group.parentWorktreeId], targetWorktreeId: main.worktreeId });
    }
    if (ordinary.length) add({ kind: "merge", sourceWorktreeIds: ordinary, targetWorktreeId: main.worktreeId });
    return { version: 1, mainWorktreeId: main.worktreeId, requestedWorktreeIds: requested, includedWorktreeIds: [...included].sort(),
      addedWorktreeIds: [...included].filter(id => !requested.includes(id)).sort(),
      groups: [...groups.values()], steps };
  }

  assertFresh(graph) {
    if (graph.version !== 1) throw fail("TASK_HIERARCHY_CHANGED", "Unsupported integration graph version.");
    for (const group of graph.groups) {
      const root = this.store.getTask(group.rootTaskId);
      if (!root || root.parent_task_id || root.archived || root.deletion_status || root.lifecycle_state === "done"
        || root.hierarchy_revision !== group.scope.expectedHierarchyRevision) throw fail("TASK_HIERARCHY_CHANGED", "The reviewed task hierarchy changed. Preserve progress and review a new plan.");
      const children = this.store.selectAll("SELECT id FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' ORDER BY id", [root.id]);
      if (JSON.stringify(children.map(child => child.id)) !== JSON.stringify(group.bindings.slice(1).map(child => child.taskId))) throw fail("TASK_HIERARCHY_CHANGED", "The reviewed child tasks changed.");
      for (const item of group.bindings) {
        const binding = this.store.getTaskDeliveryBinding(item.taskId);
        const task = this.store.getTask(item.taskId);
        if (!binding || !task || binding.worktree_id !== item.worktreeId || binding.binding_revision !== item.bindingRevision
          || (task.parent_task_id ?? null) !== item.parentTaskId || task.work_id !== root.work_id) throw fail("TASK_DELIVERY_BINDING_CHANGED", "A reviewed Task delivery changed.");
      }
    }
  }

  async acceptanceStatus(step, jobId) {
    return this.acceptance.readStatus(step.rootTaskId, { ownJobId: jobId });
  }
}
