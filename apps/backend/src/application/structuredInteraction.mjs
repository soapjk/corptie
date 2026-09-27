import { publicUserInput, validateInteractionAnswers } from "./interactionInput.mjs";

export function interactionError(message = "交互请求或答案无效。") {
  return Object.assign(new Error(message), { code: "INVALID_USER_INPUT_ANSWER", statusCode: 400 });
}

export function question(id, text, labels = null, extra = {}) {
  if (labels != null && !Array.isArray(labels)) throw interactionError();
  return { id, header: "", question: text, isOther: false, isSecret: false,
    selectionMode: "single", options: labels?.map(label => ({ label, description: "" })) ?? null, ...extra };
}

export function asyncQuestionInput(item) {
  if (item?.type !== "agentMessage" || item.delivery !== "async" || !Array.isArray(item.questions)) return null;
  if (item.questions.some(q => !q || (q.options != null && !Array.isArray(q.options)))) return null;
  return publicUserInput({ schemaVersion: 1, kind: "question", responseMode: "message",
    isBlocking: false, canCancel: true,
    questions: item.questions.map((q, i) => question(`question-${i}`, q.title, q.options, { isOther: true })) });
}

// Pure translation shared by Provider adapters. The original schema stays in
// the adapter; only bounded, declarative fields are exposed to clients.
export function elicitationInput(request) {
  const text = String(request.message ?? "需要补充信息");
  if (request.mode === "url") {
    let url;
    try { url = new URL(request.url); } catch { throw interactionError("无效的交互地址。"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw interactionError("不支持的交互地址。");
    return { schemaVersion: 1, kind: "url", isBlocking: true, canCancel: true, url: url.href,
      questions: [question("continue", `${text}\n打开网页不会自动确认完成。请完成网页流程后再提交。`, ["已完成网页操作"])] };
  }
  if (request.mode != null && !["form", "openai/form", "openaiForm"].includes(request.mode)) throw interactionError("不支持的表单模式。");
  const schema = request.requestedSchema;
  if (schema?.type !== "object" || !schema.properties || typeof schema.properties !== "object"
    || Array.isArray(schema.properties)) throw interactionError("不支持的表单结构。");
  if (Object.keys(schema).some(key => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key))) throw interactionError("表单包含暂不支持的约束。");
  const required = schema.required ?? [];
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== "boolean") throw interactionError("暂不支持动态字段。");
  if (!Array.isArray(required) || required.some(key => !Object.hasOwn(schema.properties, key))) throw interactionError();
  const questions = Object.entries(schema.properties).map(([key, field], i) => {
    if (!field || Object.keys(field).some(k => !["type", "title", "description", "enum", "enumNames", "default", "minLength", "maxLength", "minimum", "maximum", "format"].includes(k))) throw interactionError("表单字段含暂不支持的约束。");
    if (!["string", "number", "integer", "boolean"].includes(field.type)) throw interactionError("暂不支持嵌套表单或数组字段。");
    if (field.enum != null && (!Array.isArray(field.enum) || !field.enum.length || field.enum.some(v => typeof v !== (field.type === "integer" ? "number" : field.type)))) throw interactionError("无效的枚举字段。");
    if (field.format && !["email", "uri", "date", "date-time"].includes(field.format)) throw interactionError("暂不支持该字段格式。");
    const labels = field.enum ? field.enum.map(String) : field.type === "boolean" ? ["true", "false"] : null;
    return question(`field-${i}`, [field.title ?? key, field.description, i === 0 ? text : null].filter(Boolean).join("\n"), labels,
      { required: required.includes(key) });
  });
  const input = publicUserInput({ schemaVersion: 1, kind: "form", isBlocking: true, canCancel: true, questions });
  if (!input) throw interactionError("表单超出支持的字段数量或长度。");
  return input;
}

export function elicitationResponse(request, input) {
  if (input.action === "cancel") return { action: "cancel", content: null };
  const model = elicitationInput(request);
  if (!validateInteractionAnswers(model, input.answers)) throw interactionError();
  if (request.mode === "url") return { action: "accept", content: null };
  const content = Object.create(null);
  for (const [i, [key, field]] of Object.entries(request.requestedSchema.properties).entries()) {
    const value = input.answers[`field-${i}`][0];
    if (value == null) continue;
    const converted = field.type === "boolean" ? value === "true"
      : ["number", "integer"].includes(field.type) ? Number(value) : value;
    if (field.enum && !field.enum.some(v => v === converted)) throw interactionError("请选择列出的值。");
    if (typeof converted === "number" && (!Number.isFinite(converted)
      || (field.type === "integer" && !Number.isSafeInteger(converted))
      || (field.minimum != null && converted < field.minimum) || (field.maximum != null && converted > field.maximum))) throw interactionError("数值超出允许范围。");
    if (typeof converted === "string") {
      if ((field.minLength != null && converted.length < field.minLength) || (field.maxLength != null && converted.length > field.maxLength)) throw interactionError("文字长度不符合要求。");
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(converted)) throw interactionError("请输入有效邮箱。");
      if (field.format === "uri") { try { new URL(converted); } catch { throw interactionError("请输入有效地址。"); } }
      if (["date", "date-time"].includes(field.format) && !Number.isFinite(Date.parse(converted))) throw interactionError("请输入有效日期。");
    }
    content[key] = converted;
  }
  return { action: "accept", content };
}

function permissionParts(request) {
  const profile = request.permissions ?? {};
  const parts = [];
  if (Object.keys(profile).some(key => !["network", "fileSystem"].includes(key))) throw interactionError("未知权限类型。");
  if (profile.network && Object.keys(profile.network).some(key => key !== "enabled")) throw interactionError("未知网络权限。");
  if (profile.network?.enabled === true) parts.push({ label: "允许网络访问", path: ["network", "enabled"], value: true });
  const fs = profile.fileSystem ?? {};
  if (Object.keys(fs).some(key => !["read", "write", "entries", "globScanMaxDepth"].includes(key))) throw interactionError("未知文件权限类型。");
  for (const key of ["read", "write", "entries"]) {
    if (fs[key] != null && !Array.isArray(fs[key])) throw interactionError();
    for (const value of fs[key] ?? []) parts.push({ label: `${key === "read" ? "读取" : key === "write" ? "写入" : "文件权限"}：${typeof value === "string" ? value : JSON.stringify(value)}`, path: ["fileSystem", key], value });
  }
  if (!parts.length || parts.length > 12 || parts.some(p => p.label.length > 200)) throw interactionError("权限请求无法完整展示，已拒绝。");
  return parts;
}

export function permissionInput(request) {
  const parts = permissionParts(request);
  const model = publicUserInput({ schemaVersion: 1, kind: "permissions", isBlocking: true, canCancel: true, questions: [
    question("permissions", ["选择授予的权限（不选即不授予）", request.reason, request.cwd].filter(Boolean).join("\n"), parts.map(p => p.label), { selectionMode: "multiple", required: false }),
    question("scope", "授权有效范围", ["仅当前轮次", "当前会话"])
  ] });
  if (!model) throw interactionError("权限请求无法完整展示，已拒绝。");
  return model;
}

export function permissionResponse(request, input) {
  if (input.action === "cancel") return { permissions: {}, scope: "turn" };
  if (!validateInteractionAnswers(permissionInput(request), input.answers)) throw interactionError();
  const permissions = {};
  for (const part of permissionParts(request)) {
    if (!input.answers.permissions.includes(part.label)) continue;
    const [group, key] = part.path;
    permissions[group] ??= {};
    if (group === "network") permissions[group][key] = part.value;
    else (permissions[group][key] ??= []).push(part.value);
  }
  // Never expand the requested scope or invent new paths.
  if (permissions.fileSystem && request.permissions.fileSystem.globScanMaxDepth != null)
    permissions.fileSystem.globScanMaxDepth = request.permissions.fileSystem.globScanMaxDepth;
  return { permissions, scope: input.answers.scope[0] === "当前会话" ? "session" : "turn" };
}

export function structuredRequest(request) {
  if (request.method === "item/permissions/requestApproval") return permissionInput(request.params);
  if (request.method === "mcpServer/elicitation/request") return elicitationInput(request.params);
  return null;
}

export function structuredResponse(request, input) {
  if (request.method === "item/permissions/requestApproval") return permissionResponse(request.params, input);
  if (request.method === "mcpServer/elicitation/request") return elicitationResponse(request.params, input);
  throw interactionError();
}
