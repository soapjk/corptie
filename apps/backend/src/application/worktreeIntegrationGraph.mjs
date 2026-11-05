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

  async build(inspection, requestedIds, {onNotice=()=>{}}={}) {
    const decorated = await this.hierarchy.decorateInspection(inspection);
    const byId = new Map(decorated.worktrees.map(tree => [tree.worktreeId, tree]));
    const main = byId.get(inspection.mainWorktreeId);
    if (!main) throw fail("WORKTREE_NOT_FOUND", "The main Worktree is unavailable.");
    const requested = [...new Set(requestedIds)].sort();
    const included = new Set();
    const groups = new Map();
    const ordinary = [];
    const ensureGroup = taskId => {
      if(groups.has(taskId)) return groups.get(taskId);
      const root=this.hierarchy.resolveTaskDelivery(taskId,{allowAdoption:false});
      if(root.task.archived || root.task.deletion_status || root.binding.repository_id!==inspection.repositoryId)
        throw fail("TASK_PARENT_INVALID","The Task delivery is unavailable in this repository.");
      const parent=byId.get(root.binding.worktree_id);
      if(!parent) throw fail("WORKTREE_NOT_FOUND","The Task Worktree is unavailable.");
      const group={rootTaskId:root.task.id,parentWorktreeId:parent.worktreeId,childWorktreeIds:[],
        scope:{version:1,rootTaskId:root.task.id,expectedHierarchyRevision:root.task.hierarchy_revision,
          expectedBindingRevision:root.binding.binding_revision},
        bindings:[{taskId:root.task.id,worktreeId:root.binding.worktree_id,bindingRevision:root.binding.binding_revision,
          parentTaskId:root.task.parent_task_id ?? null}]};
      groups.set(taskId,group);included.add(parent.worktreeId);return group;
    };
    for(const id of requested) {
      const tree=byId.get(id);
      if(!tree || tree.isMain) throw fail("WORKTREE_NOT_FOUND",`Invalid source Worktree: ${id}.`);
      included.add(id);
      if(!tree.hierarchy) {ordinary.push(id);continue;}
      let delivery=this.hierarchy.resolveTaskDelivery(tree.hierarchy.taskId,{allowAdoption:false});
      const seen=new Set();
      while(delivery.task.parent_task_id) {
        if(seen.has(delivery.task.id)) throw fail("TASK_PARENT_INVALID","Cyclic Task hierarchy.");
        seen.add(delivery.task.id);
        const group=ensureGroup(delivery.task.parent_task_id);
        if(!group.childWorktreeIds.includes(delivery.binding.worktree_id)) {
          group.childWorktreeIds.push(delivery.binding.worktree_id);
          group.bindings.push({taskId:delivery.task.id,worktreeId:delivery.binding.worktree_id,
            bindingRevision:delivery.binding.binding_revision,parentTaskId:delivery.task.parent_task_id});
        }
        delivery=this.hierarchy.resolveTaskDelivery(delivery.task.parent_task_id,{allowAdoption:false});
      }
      ensureGroup(delivery.task.id);
    }
    const steps = [];
    const add = step => steps.push({ id: `step:${steps.length + 1}`, dependsOn: steps.at(-1)?.id ?? null,
      sourceBranchNames: step.sourceWorktreeIds.map(id => byId.get(id)?.branchName ?? id),
      targetBranchName: byId.get(step.targetWorktreeId)?.branchName ?? step.targetWorktreeId, ...step });
    const depth=group=>{
      let n=0,current=this.store.getTask(group.rootTaskId);const seen=new Set();
      while(current?.parent_task_id && !seen.has(current.id)) {seen.add(current.id);n++;current=this.store.getTask(current.parent_task_id);}
      return n;
    };
    for(const group of [...groups.values()].sort((a,b)=>depth(b)-depth(a) || a.rootTaskId.localeCompare(b.rootTaskId))) {
      if(group.childWorktreeIds.length) add({kind:"merge_children",rootTaskId:group.rootTaskId,
        sourceWorktreeIds:group.childWorktreeIds,targetWorktreeId:group.parentWorktreeId});
      if(!this.store.getTask(group.rootTaskId)?.parent_task_id) {
        add({kind:"merge_main_into_parent",rootTaskId:group.rootTaskId,
          sourceWorktreeIds:[main.worktreeId],targetWorktreeId:group.parentWorktreeId});
        add({kind:"promote_parent",rootTaskId:group.rootTaskId,
          sourceWorktreeIds:[group.parentWorktreeId],targetWorktreeId:main.worktreeId});
      }
    }
    if (ordinary.length) add({ kind: "merge", sourceWorktreeIds: ordinary, targetWorktreeId: main.worktreeId });
    for(const notice of decorated.deliveryNotices ?? []) if(included.has(notice.parentWorktreeId)) onNotice(notice);
    return { version: 1, mainWorktreeId: main.worktreeId, requestedWorktreeIds: requested, includedWorktreeIds: [...included].sort(),
      addedWorktreeIds: [...included].filter(id => !requested.includes(id)).sort(),
      groups: [...groups.values()], steps };
  }

  assertFresh(graph) {
    if (graph.version !== 1) throw fail("TASK_HIERARCHY_CHANGED", "Unsupported integration graph version.");
    for(const group of graph.groups) {
      const root=this.store.getTask(group.rootTaskId);
      if(!root || root.archived || root.deletion_status) throw fail("TASK_PARENT_UNAVAILABLE","The Task was removed or archived.");
      for(const item of group.bindings) {
        const binding=this.store.getTaskDeliveryBinding(item.taskId),task=this.store.getTask(item.taskId);
        if(!binding || !task || binding.worktree_id!==item.worktreeId
          || (task.parent_task_id ?? null)!==item.parentTaskId || task.work_id!==root.work_id)
          throw fail("TASK_DELIVERY_BINDING_CHANGED","A delivery target is no longer owned by this Task.");
      }
    }
    return graph;
  }

  async acceptanceStatus(step, jobId) {
    return this.acceptance.readStatus(step.rootTaskId, { ownJobId: jobId });
  }
}
