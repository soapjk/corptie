import { DETAIL_COMPONENTS_PROFILE_2 } from "./detailPresentationCatalog.mjs";
import { detailV2TemplateID } from "./detailV2Catalog.mjs";

const field = maxLength => ({ type: "string", required: true, maxLength });
const node = (id, kind, binding, props = {}, children = []) => ({ id, kind, props, children, ...(binding ? { binding } : {}) });
const label = fallback => ({ fallback });
const preview = value => Array.from(String(value ?? "").replace(/\s+/g, " ")).slice(0, 400).join("");
const complete = value => {
  if (value == null) return "";
  if (typeof value !== "string" || [...value].length > 65536) throw Object.assign(new Error("Detail content too large"), { code: "DETAIL_MODULE_TOO_LARGE", status: 413 });
  return value;
};
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
const templates = new Map();
export const DETAIL_PRESENTATION_BUSINESS_MODULES = Object.freeze(["focusTasks", "references", "artifacts", "memories", "memoryHits", "schedules", "provider", "turn", "worktree"]);

/** Host-only refinement of already authorized business facts. No new actions. */
export function refineBusinessPresentation(card, scope, results) {
  const base = card.template;
  const key = base.templateId + ":" + card.id.replace(/^memory-editor-.*/, "memory-editor").replace(/^(references|schedules)-operation-.*/, "$1-operation") + ":" + Boolean(card.actions?.refresh);
  let structure = structuredClone(base); delete structure.templateId;
  structure.catalogProfile = DETAIL_COMPONENTS_PROFILE_2;
  structure.card.render = { kind: "native" };
  if (card.actions?.refresh) structure.requiredCapabilities.push("detail.button");
  for (const item of structure.card.nodes) if (item.kind === "detail.button") {
    const action = card.actions?.[item.props.actionId];
    item.props.presentationRole = action?.confirmation === "destructive" ? "destructive" : action?.kind === "navigation" ? "link" : "primary";
  }
  for (const item of structure.card.nodes) if (item.kind === "detail.resourceList") item.props.presentationRole = "link";
  const root = structure.card.nodes.find(item => item.id === structure.card.rootNodeId);
  if (card.id === "task-information") {
    const values = { description: complete(scope.task.description), acceptanceCriteria: complete(scope.task.acceptance_criteria),
      verificationCriteria: complete(scope.task.verification_criteria) };
    const headings = { description: "描述", acceptanceCriteria: "验收标准", verificationCriteria: "验证标准" };
    card.fields = { title: card.fields.title, state: card.fields.state, ...values };
    structure.fieldSchema = { title: field(512), state: field(1024) };
    root.children = ["state"];
    structure.card.nodes = [root, node("state", "detail.status", "state", { semantic: "neutral" })];
    for (const [name, value] of Object.entries(values)) {
      structure.fieldSchema[name] = field(65536); structure.fieldSchema[name + "Preview"] = field(512);
      card.fields[name + "Preview"] = preview(value) || "暂无内容";
      root.children.push(name + "Section");
      structure.card.nodes.push(node(name + "Section", "disclosure", null,
        { label: label(headings[name]), previewBinding: name + "Preview", initiallyExpanded: false }, [name + "Body"]),
        node(name + "Body", "detail.markdown", name));
    }
    if (card.actions?.edit) { root.children.push("edit"); structure.card.nodes.push(node("edit", "detail.button", null, { actionId: "edit", presentationRole: "link" })); }
  } else if (card.id === "business-artifacts") {
    // One resource list, not a second aggregate of the same titles and audit facts.
    card.fields.body = "";
    root.children = root.children.filter(id => id !== "body");
    structure.card.nodes = structure.card.nodes.filter(item => item.id !== "body");
  } else if (card.id === "business-provider") {
    const data = results.provider?.data;
    card.fields = { title: "Provider", state: card.fields.state, providerName: data?.currentProviderName || "未获取",
      model: data?.model || "未设置", reasoning: data?.reasoning || "未设置", switching: data?.switching ? "正在切换" : "当前环境" };
    delete card.page;
    structure.collectionSchema = {};
    structure.fieldSchema = Object.fromEntries(Object.keys(card.fields).map(name => [name, field(1024)]));
    root.children = ["state", "providerName", "model", "reasoning", "switching"];
    structure.card.nodes = [root, node("state", "detail.status", "state", { semantic: "neutral" }),
      ...[["providerName", "Provider"], ["model", "模型"], ["reasoning", "推理配置"], ["switching", "状态"]]
        .map(([name, title]) => node(name, "detail.keyValue", name, { label: label(title) }))];
    structure.requiredCapabilities = ["detail.keyValue", "detail.status"];
    if (card.actions?.manage) {
      root.children.push("manage"); structure.requiredCapabilities.push("detail.button");
      structure.card.nodes.push(node("manage", "detail.button", null, { actionId: "manage", presentationRole: "link" }));
    }
  } else if (["business-memories", "business-memoryHits"].includes(card.id)) {
    const name = card.id.slice(9), rows = results[name]?.data?.items ?? [];
    card.fields.title = name === "memoryHits" ? "本 Session 已命中记忆" : "记忆管理";
    card.fields.body = "";
    const itemSchema = structure.collectionSchema.resources.itemSchema;
    Object.assign(itemSchema, { preview: field(512), body: field(65536), metadata: field(1024) });
    for (const row of rows) {
      const item = card.page.items[row.resource.id], body = complete(row.content);
      item.title = ({ preference: "偏好", fact: "事实", workflow: "工作方式", lesson: "经验" })[row.kind] ?? row.kind ?? "记忆";
      item.preview = row.unavailable ? "内容已不可用" : preview(body);
      item.body = row.unavailable ? "内容已不可用，仅保留命中记录" : body;
      item.metadata = name === "memoryHits" ? row.snapshotAtRecall ? "命中时的内容快照" : "已实际命中"
        : [row.sourceType === "direct_user" ? "用户提供" : "记忆资源", row.revokedAt ? "已撤销" : ""].filter(Boolean).join(" · ");
      // A historical hit is a read-only fact, not authority to edit another owner's memory.
      if (name === "memoryHits") delete item.actionId;
    }
    const resources = structure.card.nodes.find(item => item.kind === "detail.resourceList");
    resources.props.presentation = "disclosure";
    resources.props.itemBindings = { preview: "preview", body: "body", metadata: "metadata" };
    root.children = root.children.filter(id => id !== "body");
    structure.card.nodes = structure.card.nodes.filter(item => item.id !== "body");
    if (name === "memories") {
      root.children = root.children.map(id => id === "resources" ? "memoryResources" : id);
      structure.card.nodes.push(node("memoryResources", "disclosure", null,
        { label: label("查看与管理记忆资源"), initiallyExpanded: false }, ["resources"]));
    }
  } else if (card.id.startsWith("memory-editor-") || card.id.endsWith("-operation") || /^(references|schedules)-operation-/.test(card.id)) {
    const content = root.children.filter(id => id !== "state");
    root.children = ["state", "operationDetails"];
    structure.card.nodes.push(node("operationDetails", "disclosure", null, { label: label("管理与操作"), initiallyExpanded: false }, content));
  }
  structure.requiredCapabilities = [...new Set(structure.requiredCapabilities)].sort();
  if (!templates.has(key)) {
    if (templates.size >= 64) templates.clear();
    templates.set(key, freeze({ ...structure, templateId: detailV2TemplateID(structure) }));
  }
  card.template = templates.get(key);
  return card;
}
