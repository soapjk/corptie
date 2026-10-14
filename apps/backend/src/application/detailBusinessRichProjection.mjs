import { DETAIL_COMPONENTS_CATALOG, detailV2TemplateID } from "./detailV2Catalog.mjs";
import { detailV2Hash, detailV2StateHash, validateDetailV2, canonicalDetailV2 } from "./detailSyncV2.mjs";
import { detailBusinessDate } from "./detailBusinessDate.mjs";

const text = fallback => ({ fallback });
const stringSchema = maxLength => ({ type: "string", required: true, maxLength });
const bounded = (value, limit = 2000) => typeof value === "string" ? value.slice(0, limit) : "";
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
const node = (id, kind, binding, props = {}, children = []) => ({ id, kind, props, children, ...(binding ? { binding } : {}) });
export const DETAIL_RICH_BUSINESS_MODULES = Object.freeze(["focusTasks", "references", "artifacts", "memories", "recalls", "schedules", "provider", "turn", "worktree"]);
export const DETAIL_RICH_BUSINESS_CAPABILITIES = Object.freeze(["detail.dateTime", "detail.keyValue", "detail.markdown", "detail.resourceList", "detail.status"]);
const template = (list, dated = false, navigation = false) => {
  // Twenty fixed optional date pairs keep template identity independent of rows.
  // Dates are never formatted by the backend; native locale/timezone owns display.
  const dateFields = dated ? Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
    [`date${i}`, { type: "string", required: false, maxLength: 64 }],
    [`scheduledDate${i}`, { type: "string", required: false, maxLength: 64 }],
    [`dateLabel${i}`, { type: "string", required: false, maxLength: 512 }]
  ]).flat()) : {};
  const dateNodes = dated ? Array.from({ length: 20 }, (_, i) => [
    node(`dateLabel${i}`, "detail.keyValue", `dateLabel${i}`),
    node(`date${i}`, "detail.dateTime", `date${i}`, { format: "dateTime" }),
    node(`scheduledDate${i}`, "detail.dateTime", `scheduledDate${i}`, { format: "dateTime" })
  ]).flat() : [];
  const structure = { templateVersion: 1, catalogProfile: DETAIL_COMPONENTS_CATALOG,
    requiredCapabilities: [...(navigation ? ["detail.button"] : []), ...(dated ? ["detail.dateTime", "detail.keyValue"] : []), "detail.markdown", ...(list ? ["detail.resourceList"] : []), "detail.status"],
    fieldSchema: { title: stringSchema(512), body: stringSchema(32768), state: stringSchema(1024), ...dateFields },
    collectionSchema: list ? { resources: { maxItems: 20, itemSchema: {
      title: stringSchema(512), resourceType: stringSchema(512), id: stringSchema(512),
      ...(navigation ? { actionId: { type: "string", required: false, maxLength: 128 } } : {})
    } } } : {},
    card: { title: text("Detail"), titleBinding: "title", semanticKind: "information", rootNodeId: "root",
      fallback: text("暂时无法显示"), nodes: [node("root", "column", null, {}, ["state", ...(list ? ["resources"] : []), "body", ...dateNodes.map(n => n.id)]),
        node("state", "detail.status", "state", { semantic: "neutral" }),
        ...(list ? [node("resources", "detail.resourceList", null, { collection: "resources" })] : []),
        node("body", "detail.markdown", "body"), ...dateNodes] } };
  return freeze({ ...structure, templateId: detailV2TemplateID(structure) });
};
const contentTemplate = template(false), listTemplate = template(true), datedListTemplate = template(true, true);
const navigationListTemplate = template(true, false, true), navigationDatedListTemplate = template(true, true, true);
const templateHashes = new Map([contentTemplate, listTemplate, datedListTemplate, navigationListTemplate, navigationDatedListTemplate].map(value => [value, detailV2Hash(value)]));
const listDefinitions = {
  focusTasks: { title: "重点 Task", rowTitle: row => row.title,
    facts: row => [row.summary?.focus, row.summary?.progress, row.summary?.reason] },
  references: { title: "引用", rowTitle: row => row.displayName || row.targetType,
    facts: row => [row.targetType, row.status, row.enabled ? "已启用" : "已停用"] },
  artifacts: { title: "Artifact", rowTitle: row => row.title,
    facts: row => [row.summary, row.status, `固定版本：${row.version ?? "不可读"}`, row.contentHash,
      ...(row.references ?? []).slice(0, 20).flatMap(reference => [reference.required ? "required" : "optional",
        reference.pendingVersion ? `待确认版本：${reference.pendingVersion} / ${bounded(reference.pendingHash, 64)}` : ""])] },
  memories: { title: "记忆", rowTitle: row => row.kind,
    facts: row => [row.content, row.sourceType, row.trustLevel, row.revokedAt ? "已撤销" : row.promotionStatus] },
  recalls: { title: "记忆召回诊断", rowTitle: row => row.phase,
    date: row => row.createdAt, dateLabel: "召回时间",
    facts: row => [row.mode, row.reason, row.injectionStatus, ...(row.selectedEntries ?? []).slice(0, 20)
      .flatMap(entry => [entry.kind, entry.content, entry.snapshotAtRecall ? "召回时快照" : ""])] },
  schedules: { title: "计划任务", rowTitle: row => row.name,
    date: row => row.nextRunAt, secondDate: row => row.runAt, dateLabel: "下一次执行 / 计划执行",
    facts: row => [row.scheduleType, row.status, row.scheduleTimezone] },
  provider: { title: "Provider 能力", rowTitle: row => row.name,
    facts: row => [row.available ? "可用" : "不可用", ...(row.capabilities ?? []).slice(0, 128)] }
};
const readState = result => {
  if (!result || !["ready", "empty", "error"].includes(result.state)) throw new Error("DETAIL_BUSINESS_READ_STATE");
  if (result.state !== "error") return null;
  return result.code === "DETAIL_MODULE_UNAVAILABLE" ? "模块不可用"
    : result.code === "DETAIL_MODULE_ACCESS_DENIED" ? "无权读取" : "读取失败";
};
const dateValue = value => {
  if (value == null) return null;
  if (detailBusinessDate(value) === null) throw new Error("DETAIL_BUSINESS_DATE_INVALID");
  return value;
};
function resourcePage(result) {
  const rows = result.state === "ready" || result.state === "empty" ? (result.data?.items ?? []) : [];
  if (!Array.isArray(rows) || rows.length > 20) throw new Error("DETAIL_BUSINESS_PAGE_LIMIT");
  return rows;
}
function listCard(name, result) {
  const definition = listDefinitions[name];
  if (!definition) throw new Error("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE");
  const errorState = readState(result);
  const rows = resourcePage(result), items = Object.create(null), order = [];
  // Host-only mapping: never add Session bindings to wire collection fields.
  const navigationTargets = Object.create(null);
  for (const row of rows) {
    const { resourceType, id } = row.resource ?? {};
    if (!/^[\x20-\x7e]{1,512}$/.test(id ?? "") || !/^[\x20-\x7e]{1,512}$/.test(resourceType ?? "") || Object.hasOwn(items, id)) {
      throw new Error("DETAIL_BUSINESS_RESOURCE_ID");
    }
    order.push(id); items[id] = { resourceType, id, title: bounded(definition.rowTitle(row), 512) };
    if (name === "focusTasks" && resourceType === "task" && row.sessionTarget?.resourceType === "session"
      && typeof row.sessionTarget.id === "string" && /^[\x20-\x7e]{1,512}$/.test(row.sessionTarget.id)) {
      navigationTargets[id] = { resourceType: "session", id: row.sessionTarget.id };
    }
  }
  const state = errorState ?? (rows.length === 0 ? "暂无内容"
    : result.data.hasMore ? "当前页（更多内容尚未接线）" : "");
  const body = rows.map(row => [bounded(definition.rowTitle(row), 512), ...definition.facts(row).map(value => bounded(value))]
    .filter(Boolean).join("\n\n")).join("\n\n---\n\n");
  const fields = { title: definition.title, state, body: bounded(body, 32768) };
  if (definition.date) rows.forEach((row, i) => {
    const date = dateValue(definition.date(row));
    const secondDate = definition.secondDate ? dateValue(definition.secondDate(row)) : null;
    if (date !== null) fields[`date${i}`] = date;
    if (secondDate !== null) fields[`scheduledDate${i}`] = secondDate;
    if (date !== null || secondDate !== null) fields[`dateLabel${i}`] = bounded(`${definition.rowTitle(row) ?? ""} · ${definition.dateLabel}`, 512);
  });
  return { id: `business-${name}`, template: definition.date ? datedListTemplate : listTemplate, fields,
    page: { order, items, nextCursor: null }, navigationTargets };
}
const metrics = value => Object.entries(value ?? {}).filter(([key, v]) => /^[A-Za-z0-9_.]{1,64}$/.test(key)
  && (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) && Number.isFinite(Number(v)) && Number(v) >= 0)
  .slice(0, 20).map(([key, v]) => `${bounded(key, 128)}: ${v}`).join("\n\n");
function moduleCard(name, result) {
  const errorState = readState(result), data = result.state === "ready" ? result.data : null;
  if (name === "provider") {
    const card = listCard(name, { ...result, data: { items: data?.providers ?? [], hasMore: data?.hasMore === true } });
    card.fields.body = bounded([data?.model, data?.reasoning, card.fields.body].filter(Boolean).join("\n\n"), 32768);
    return card;
  }
  if (name !== "turn" && name !== "worktree") return listCard(name, result);
  const title = name === "turn" ? "Turn 分析" : "Workspace / Worktree";
  const body = !data ? "" : name === "turn" ? [data.completeness, "Wall", metrics(data.wall), "Wall partition", metrics(data.wallPartition), "Inclusive", metrics(data.inclusive)].join("\n\n")
    : [data.attached ? "已关联" : "未关联", data.blockedReason, data.mainBranch, data.tree?.branchName,
      data.tree?.isMain ? "主 Worktree" : "", data.tree?.dirty === true ? "有未提交改动" : data.tree?.dirty === false ? "干净" : "",
      data.tree?.availability, data.tree?.operationState,
      metrics({ aheadOfMain: data.tree?.aheadOfMain, behindMain: data.tree?.behindMain, changedFileCount: data.tree?.changedFileCount }),
      data.autoFollow?.enabled ? "自动跟随已启用" : "自动跟随未启用", data.autoFollow?.status, data.autoFollow?.reason, data.job?.status, data.job?.phase].filter(Boolean).join("\n\n");
  return { id: `business-${name}`, template: contentTemplate,
    fields: { title, state: errorState ?? (data ? "只读" : "暂无内容"), body: bounded(body, 32768) } };
}

/** Offline producer against the fixed shared catalog, not a renderer or HTTP
 * gate. Navigation is explicit host opt-in for normalized registered targets;
 * no command, cursor, editor or resource loader is invented. Old UI remains active. */
export function projectDetailBusinessRich(scope, readResults = {}, { profile, generation, previous = null, navigation = false } = {}) {
  if (profile?.catalog !== DETAIL_COMPONENTS_CATALOG) throw new Error("DETAIL_BUSINESS_RICH_PROFILE_REQUIRED");
  if (previous) validateDetailV2(previous, profile);
  const documentId = `detail:${scope.logicalSessionId}`;
  if (previous && (previous.documentId !== documentId || previous.sessionId !== scope.logicalSessionId || previous.generation !== generation)) previous = null;
  const cards = [];
  if (scope.session.sessionKind === "worker" && scope.task) cards.push({ id: "task-information", template: contentTemplate,
    fields: { title: bounded(scope.task.title, 512), state: "只读 Task 定义", body: bounded([
      "描述", bounded(scope.task.description, 10000), "验收标准", bounded(scope.task.acceptance_criteria, 10000),
      "验证标准", bounded(scope.task.verification_criteria, 10000)
    ].join("\n\n"), 32768) } });
  if (scope.session.sessionKind === "workChat" && scope.work) cards.push({ id: "work-overview", template: contentTemplate,
    fields: { title: bounded(scope.work.name, 512), state: "只读 Work 概述", body: bounded(scope.work.description, 32768) } });
  for (const [name, result] of Object.entries(readResults)) {
    if (!DETAIL_RICH_BUSINESS_MODULES.includes(name)) throw new Error("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE");
    cards.push(moduleCard(name, result));
  }
  const templates = Object.create(null), instances = Object.create(null), references = Object.create(null);
  for (const card of cards) {
    const actions = {};
    if (navigation && profile.clientCapabilities.includes("detail.button") && card.page) {
      card.template = card.template === datedListTemplate ? navigationDatedListTemplate : navigationListTemplate;
      for (const item of Object.values(card.page.items)) {
        const target = card.id === "business-focusTasks" ? card.navigationTargets[item.id]
          : { resourceType: { contextReference: "reference", automation: "schedule" }[item.resourceType] ?? item.resourceType, id: item.id };
        if (!target || !["session", "task", "work", "schedule", "artifact", "memory", "reference"].includes(target.resourceType)) continue;
        const id = `open-${detailV2Hash({ type: target.resourceType, id: target.id }).slice(7, 31)}`;
        item.actionId = id;
        actions[id] = { id, kind: "navigation", operation: "resource.open", label: text("打开"), available: true, target };
      }
    }
    const templateHash = templateHashes.get(card.template), old = previous?.instances[card.id];
    templates[templateHash] = card.template; references[card.id] = { templateId: card.template.templateId, templateHash };
    const collections = {};
    if (card.page) {
      const oldPage = old?.collections.resources;
      const { revision: ignored, ...oldBody } = oldPage ?? {};
      collections.resources = { ...card.page, revision: oldPage
        ? oldPage.revision + (canonicalDetailV2(oldBody) === canonicalDetailV2(card.page) ? 0 : 1) : 1 };
    }
    const body = { fields: card.fields, collections, actions }, hash = detailV2Hash(body);
    instances[card.id] = old?.hash === hash ? old : { ...body, hash, revision: old ? old.revision + 1 : 1 };
  }
  const manifestBody = { cards: references, order: cards.map(card => card.id) }, hash = detailV2Hash(manifestBody);
  const manifest = { ...manifestBody, hash, revision: previous ? previous.manifest.revision + (previous.manifest.hash === hash ? 0 : 1) : 1 };
  const state = { protocolVersion: 2, documentId, sessionId: scope.logicalSessionId, generation,
    revision: previous ? previous.revision + 1 : 1, templates, instances, manifest };
  state.stateHash = detailV2StateHash(state);
  if (previous?.stateHash === state.stateHash) return previous;
  return validateDetailV2(state, profile);
}
