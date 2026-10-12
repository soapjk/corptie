import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (key, fallback) => ({ key, fallback });
const bounded = value => typeof value === "string" ? value.slice(0, 16000) : "";
const field = (id, binding, kind = "text") => ({ id, kind, props: {}, ...(binding ? { binding } : {}), children: [] });
const column = children => ({ id: "root", kind: "column", props: {}, children });
function card(id, title, semanticKind, nodes, data) {
  return { id, title, semanticKind, templateRevision: 1, dataRevision: digest(data),
    rootNodeId: "root", nodes, data,
    actions: [{ id: "refresh", kind: "read", operation: "detail.refresh", label: text("detail.refresh", "刷新"), available: true }],
    fallback: text("detail.unavailable", "此卡片暂时无法显示") };
}

// Business modules use only the frozen native-v1 catalog. New modules stay
// opt-in until the platform's editors/navigation and visual parity are wired.
export const DEFAULT_DETAIL_MODULES = Object.freeze(["session", "summary"]);
export const DETAIL_BUSINESS_MODULES = Object.freeze({
  session: {
    dependencies: ["session", "sessionMetadata", "work"],
    select: scope => ({ sessionId: scope.logicalSessionId,
      ...(scope.work ? { workName: bounded(scope.work.name) } : {}) }),
    project: data => [card("session-info", text("detail.sessionInfo", "会话信息"), "information",
      [column(["session", ...("workName" in data ? ["work"] : [])]), field("session", "sessionId"),
        ...("workName" in data ? [field("work", "workName")] : [])], data)]
  },
  summary: {
    dependencies: ["session", "sessionMetadata"],
    select: scope => ({ summary: scope.session.sessionKind === "assistantChat" ? bounded(scope.session.summary) : "" }),
    project: data => data.summary.trim() ? [card("session-summary", text("detail.sessionSummary", "会话摘要"), "summary",
      [column(["summary"]), field("summary", "summary", "markdown")], data)] : []
  },
  task: {
    dependencies: ["session", "sessionMetadata", "task"],
    select: scope => scope.session.sessionKind === "worker" && scope.task ? {
      taskId: scope.task.id, title: bounded(scope.task.title),
      description: bounded(scope.task.description), acceptance: bounded(scope.task.acceptance_criteria),
      verification: bounded(scope.task.verification_criteria)
    } : null,
    project: data => data ? [card("task-information", text("detail.taskInformation", "Task 信息"), "information", [
      column(["title", "definition"]), field("title", "title"),
      { id: "definition", kind: "disclosure", props: { label: text("detail.taskDefinition", "Task 定义") },
        children: ["description-label", "description", "acceptance-label", "acceptance", "verification-label", "verification"] },
      { ...field("description-label"), props: { text: text("detail.description", "描述") } }, field("description", "description", "markdown"),
      { ...field("acceptance-label"), props: { text: text("detail.acceptanceCriteria", "验收标准") } }, field("acceptance", "acceptance", "markdown"),
      { ...field("verification-label"), props: { text: text("detail.verificationCriteria", "验证标准") } }, field("verification", "verification", "markdown")
    ], data)] : []
  },
  work: {
    dependencies: ["session", "sessionMetadata", "work"],
    select: scope => ({ description: scope.session.sessionKind === "workChat" ? bounded(scope.work?.description) : "" }),
    project: data => data.description.trim() ? [card("work-overview", text("detail.workOverview", "Work 概述"), "information",
      [column(["description"]), field("description", "description", "markdown")], data)] : []
  }
});

export function detailModuleNames(names = DEFAULT_DETAIL_MODULES) {
  if (!Array.isArray(names) || new Set(names).size !== names.length || names.some(name => !Object.hasOwn(DETAIL_BUSINESS_MODULES, name))) {
    throw Object.assign(new Error("Invalid Detail module profile"), { code: "DETAIL_MODULE_PROFILE_INVALID" });
  }
  return [...names];
}

/** Pure, allowlisted business projection; never serializes raw store rows. */
export function projectBusinessModules(scope, names = DEFAULT_DETAIL_MODULES, previous = new Map(), dirty) {
  const modules = new Map();
  for (const name of detailModuleNames(names)) {
    const module = DETAIL_BUSINESS_MODULES[name], cached = previous.get(name);
    if (dirty && cached && !dirty.has(name)) { modules.set(name, cached); continue; }
    const input = module.select(scope), signature = JSON.stringify(input);
    // Comparing the small allowlisted input avoids hashing/rebuilding node trees
    // on Provider token events. Even an explicit dirty hint cannot force UI churn.
    const result = cached?.signature === signature ? cached : {
      signature, cards: module.project(input)
    };
    modules.set(name, result);
    dirty?.delete(name);
  }
  return modules;
}

export function businessDocument(scope, modules) {
  const cards = [...modules.values()].flatMap(module => module.cards);
  return { schemaVersion: 1, documentId: `detail:${scope.logicalSessionId}`, sessionId: scope.logicalSessionId,
    cards, order: cards.map(item => item.id) };
}
