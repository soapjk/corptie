// DSH Session RPC 适配层：HTTP 路由 handler（主入口）。
//
// 挂载在 Corptie backend 的 node:http route 函数里，处理 DSH web 前端发来的
// POST /api/{method} 请求。解析 ClientRequest 信封，按 method 分发到
// SessionApplicationService（Provider 抽象门面）与 corptieStore（事件溯源读取）。
//
// 只实现「会话本身」这一层（协议层）：list / history / create / prompt / cancel /
// rename / models / selectModel。subagent.* 等不在首批，前端走 capability-absence 降级。
//
// 额外实现 DSH 前端 boot 握手的宿主级端点：host.describe / settings.describe /
// workspace.list。DSH 前端 ConnectionController 的「严格就绪握手」要求
// host.describe 成功才会进入 connected 态（否则陷入 reconnecting 循环，永不渲染）。
// 这三个端点只需返回 schema 合法的最小值，让前端越过握手门槛。
//
// 合规性：本模块只依赖 SessionApplicationService + store，不接触具体 provider adapter。

import {
  parseClientRequest,
  okResponse,
  errorResponse,
  RpcErrorCode,
} from "./dshWireCodec.mjs";
import { mapSessionList } from "./dshSessionSummaryMapper.mjs";

// ---- DSH 宿主设置：欢迎通知（ui-onboarding） ----
//
// DSH 前端 WelcomeNoticeStore 通过 settings.describe 读取 ui-onboarding 命名空间，
// 若找不到该命名空间（或 welcomeNoticeVersion 不等于当前版本）会进入 error 态，
// 弹窗显示「暂时无法保存确认状态」。Corptie 复用 DSH 前端，但本身不是 DSH 内测
// 环境，无需展示 DSH 内测声明，故：
//   - settings.describe 始终返回一个已确认（welcomeNoticeVersion = 当前版本）的
//     ui-onboarding 命名空间，让前端 WelcomeNotice 直接判定 acknowledged=true，
//     弹窗与报错均不出现。
//   - settings.mutate 仍正确实现 set/unset（进程内持久化 + 返回新 view），
//     防止未来 DSH bundle 版本号变更导致弹窗重现时，「继续」按钮因 mutate 缺失而报错。
const WELCOME_NOTICE_NAMESPACE = "ui-onboarding";
const WELCOME_NOTICE_ACK_FIELD = "welcomeNoticeVersion";
const WELCOME_NOTICE_VERSION = "2026-08-13.1";

// 进程内持久化 ui-onboarding 的 value（仅欢迎通知确认字段）。
// Corptie 不承载 DSH 的通用 settings 语义，故用模块级 Map 而非写库。
const onboardingValues = new Map([[WELCOME_NOTICE_NAMESPACE, { [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }]]);

function onboardingNamespaceView(ns) {
  return {
    ns,
    schema: {},
    value: onboardingValues.get(ns) ?? {},
    applies: "live",
    secrets: [],
    revision: 0,
  };
}

/**
 * 处理一个 DSH RPC 请求。同步返回 false 表示「非本适配层路由」（交给上层继续）。
 * 异步返回 true 表示「已接管」（响应已写入）。
 *
 * @param {object} deps
 * @param {object} deps.request   - node:http IncomingMessage
 * @param {object} deps.response  - node:http ServerResponse
 * @param {URL}    deps.url       - 已解析的 URL
 * @param {object} deps.sessionApplicationService - SessionApplicationService 实例
 * @param {object} deps.store     - corptieStore 实例（listSessions / listSessionEvents / lastSessionEventSequence）
 * @param {function} deps.sendJson - (response, statusCode, body) => void
 * @param {function} deps.readJson - (request) => Promise<object>
 */
export async function handleDshRpcRequest(deps) {
  const { request, response, url, sessionApplicationService, store, sendJson, readJson, sendSessionMessage, createSession } = deps;
  const listStoredSessions = deps.listStoredSessions
    ?? ((options = {}) => store.listSessions({ archived: options.archived === true }));

  // 接管 /api/session.*、/api/subagent.*（subagent 暂返回不支持），以及
  // boot 握手所需的宿主级端点 host.describe / settings.describe / workspace.list。
  const pathname = url.pathname;
  const sessionMatch = pathname.match(/^\/api\/(session\.[a-zA-Z]+)$/);
  const isSubagent = pathname.startsWith("/api/subagent.");
  const bootMatch = pathname.match(/^\/api\/(host\.describe|settings\.describe|settings\.mutate|workspace\.list)$/);

  if (!sessionMatch && !isSubagent && !bootMatch) return false;

  // 只支持 POST（DSH fetch 载体统一 POST）。
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method not allowed" });
    return true;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: "invalid json body" });
    return true;
  }

  const req = parseClientRequest(body);
  if (!req) {
    sendJson(response, 400, { error: "invalid client-request envelope" });
    return true;
  }

  const { rpcId, method, payload } = req;

  try {
    const value = await dispatchDshRequest(method, payload, {
      sessionApplicationService,
      store,
      listStoredSessions,
      sendSessionMessage,
      createSession
    });
    sendJson(response, 200, okResponse(rpcId, value));
  } catch (error) {
    const code = error?.code === "SESSION_NOT_FOUND"
      ? RpcErrorCode.SESSION_NOT_FOUND
      : RpcErrorCode.INTERNAL;
    const details = code === RpcErrorCode.SESSION_NOT_FOUND
      ? { sessionId: error?.sessionId ?? String(payload?.sessionId ?? "") }
      : {};
    console.error(`[dsh-adapter] ${method} failed:`, error?.message ?? error);
    sendJson(response, 200, errorResponse(rpcId, code, error?.message ?? "internal error", details));
  }

  return true;
}

/** 按 method 分发到具体实现。 */
export async function dispatchDshRequest(method, payload, {
  sessionApplicationService,
  store,
  listStoredSessions,
  sendSessionMessage,
  createSession
}) {
  switch (method) {
    case "session.list":
      return sessionList(payload, { listStoredSessions, store });

    case "session.history":
      return sessionHistory(payload, { store });

    case "session.create":
      return sessionCreate(payload, { sessionApplicationService, createSession, store });

    case "session.prompt":
      return sessionPrompt(payload, { sessionApplicationService, sendSessionMessage });

    case "session.cancel":
      return sessionCancel(payload, { sessionApplicationService });

    case "session.rename":
      return sessionRename(payload, { sessionApplicationService });

    case "session.models":
      return sessionModels(payload, { sessionApplicationService });

    case "session.selectModel":
      return sessionSelectModel(payload, { sessionApplicationService });

    // boot 握手宿主级端点。
    case "host.describe":
      return hostDescribe(payload, { listStoredSessions });

    case "settings.describe":
      return settingsDescribe(payload);

    case "settings.mutate":
      return settingsMutate(payload);

    case "workspace.list":
      return workspaceList(payload, { store });

    // 未实现的方法（fork/search/subagent.*）统一返回 internal，前端按能力缺失降级。
    default:
      return { accepted: false };
  }
}

// ---- 只读路径 ----

async function sessionList(payload, { listStoredSessions, store }) {
  const sessions = await listStoredSessions({ archived: false });
  const revisions = typeof store?.listSessionTimelineRevisions === "function"
    ? store.listSessionTimelineRevisions()
    : new Map();
  return {
    items: mapSessionList(sessions.map((session) => ({
      ...session,
      blank: Number(revisions.get(session.id) ?? session.timelineRevision ?? 0) === 0
    })))
  };
}

async function sessionHistory(payload, { store }) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw notFound(sessionId);

  // beforeSeq（DSH 语义：向后翻页的游标）映射到 store 的 after 参数。
  const beforeSeq = Number(payload?.beforeSeq ?? 0);
  const maxMessages = Number(payload?.maxMessages ?? 200);
  const limit = Math.max(1, Math.min(1000, maxMessages));

  const lastSeq = store.lastSessionEventSequence(sessionId);
  // DSH is another Corptie client, not a Provider-history importer. Read the
  // same session_items projection as the macOS Timeline and translate only at
  // the presentation boundary. Opening DSH must work with every Provider
  // offline and must never touch Codex rollout/Claude transcript storage.
  const items = beforeSeq > 0 ? [] : store.getItems(sessionId, limit);
  const events = historyFromStoredTimelineItems(items, lastSeq);

  return {
    events,
    hasMore: false
  };
}

/**
 * 从 Corptie 的持久化 Timeline 生成 DSH 事件列表。
 *
 * 消费 session_items 的有序时间线（message / tool-call / tool-output），
 * 映射成完整的 DSH SessionEvent 序列。相比只映射对话，这里额外产出 tool/call 与
 * tool/result 事件，使 DSH 轨迹（trajectory）视图还原原生 DSH 的详细程度——agent 在
 * 一个 turn 内交替产生的工具调用与结果被逐一呈现，而不是压缩成单一的一问一答。
 *
 * 关键契约（由 dsh-client-ui-trajectory.js 与 dshEventMapper 反推）：
 *   - turn/start 建立 turn（data.turn），step/start 建立 step（data.turn+data.step）
 *   - user/message、assistant/message 是 surface 事件，必须带 surfaceOp:'append'
 *   - tool/call  非 surface 事件（不能带 surfaceOp），data 需 { turn, step, callId, name, arguments }
 *   - tool/result 是 surface-eligible 类型（在 SURFACE_EVENT_TYPES 集合里），必须带
 *     surfaceOp:'append'，data 需 { turn, step, message:{ ..., source:{kind:'tool', callId},
 *     content:[{type:'tool-result', toolCallId, content, isError}] } }
 *   - step/end、turn/end 关闭边界
 *
 * 映射规则：每个 user 消息开启新 turn；该 turn 内每个 assistant message 递增 step，
 * 紧随其后（step 未变）出现的 tool-call/tool-output 归属该 step。seq 用连续递增占位序号。
 *
 * 输入只接受 Corptie `session_items`，不接受 Provider 原生历史。
 */
export function historyFromStoredTimelineItems(items, sequenceCeiling = null) {
  const timeline = (Array.isArray(items) ? items : []).map((item) => {
    if (item.type === "userMessage") {
      return { kind: "message", role: "user", id: item.id, text: item.text, createdAt: item.createdAt };
    }
    if (["agentMessage", "text", "taskComplete"].includes(item.type)) {
      return { kind: "message", role: "assistant", id: item.id, text: item.text, createdAt: item.createdAt };
    }
    if (["commandExecution", "mcpToolCall", "toolCall"].includes(item.type)) {
      return {
        kind: "tool-call",
        callId: item.id,
        name: item.title || item.type,
        arguments: item.text || "",
        createdAt: item.createdAt
      };
    }
    if (["terminalOutput", "toolOutput"].includes(item.type)) {
      return {
        kind: "tool-output",
        id: item.id,
        callId: item.turnId || item.id,
        output: item.text || "",
        createdAt: item.createdAt
      };
    }
    return null;
  }).filter(Boolean);
  if (timeline.length === 0) return [];

  const events = [];
  const push = (type, data, surfaceOp, createdAt = null) => {
    const parsedTime = typeof createdAt === "number" ? createdAt : Date.parse(createdAt ?? "");
    const ev = { type, seq: events.length, time: Number.isFinite(parsedTime) ? parsedTime : Date.now(), data };
    if (surfaceOp) ev.surfaceOp = surfaceOp;
    events.push({ event: ev });
  };

  const userMessage = (text, id) => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
  const assistantMessage = (text, id) => ({
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    source: { kind: "model", provider: "codex", model: "codex" },
  });

  let turn = 0;
  let step = 0;
  let turnOpen = false;
  // stepOpen：当前是否有一个已 step/start 但尚未 step/end 的 assistant step。
  // Timeline 里「assistant message → 工具调用 → assistant message → …」交错出现，
  // 工具调用应归属触发它的那个 assistant message 所属的 step，而非下一个尚未开启的 step。
  // 因此 step/start 在 assistant message 处开启，并在紧随其后的工具调用序列结束、下一个
  // assistant message 到来时再 step/end（而非每个 assistant 立即闭合）。
  let stepOpen = false;
  let lastCreatedAt = null;

  const ensureTurn = () => {
    if (!turnOpen) {
      push("turn/start", { turn }, undefined, lastCreatedAt);
      turnOpen = true;
      turn += 1;
    }
    return turn - 1;
  };

  // 闭合当前 step（若开启），供「下一个 assistant message 到来」或「turn 结束」时调用。
  const closeStep = (turnNo) => {
    if (stepOpen) {
      push("step/end", { turn: turnNo, step }, undefined, lastCreatedAt);
      stepOpen = false;
      step += 1;
    }
  };

  for (const item of timeline) {
    lastCreatedAt = item.createdAt ?? lastCreatedAt;
    if (item.kind === "message" && item.role === "user") {
      if (turnOpen) {
        closeStep(turn - 1);
        push("turn/end", { turn: turn - 1, reason: { kind: "completed" } }, undefined, lastCreatedAt);
        turnOpen = false;
      }
      push("turn/start", { turn }, undefined, item.createdAt);
      push("user/message", userMessage(item.text, item.id), "append", item.createdAt);
      step = 0;
      stepOpen = false;
      turnOpen = true;
      turn += 1;
    } else if (item.kind === "message" && item.role === "assistant") {
      const turnNo = ensureTurn();
      // 前一个 assistant step 结束时才闭合（此时其工具调用已全部归属该 step）。
      closeStep(turnNo);
      push("step/start", { turn: turnNo, step }, undefined, item.createdAt);
      stepOpen = true;
      push("assistant/message", { turn: turnNo, step, message: assistantMessage(item.text, item.id) }, "append", item.createdAt);
    } else if (item.kind === "tool-call") {
      const turnNo = ensureTurn();
      // 工具调用归属当前开启的 step；若 Timeline 以工具调用开头（无前置 assistant），
      // 为其开启一个 step 以保证轨迹仍可定位。
      if (!stepOpen) {
        push("step/start", { turn: turnNo, step }, undefined, item.createdAt);
        stepOpen = true;
      }
      push("tool/call", {
        turn: turnNo,
        step,
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
      }, undefined, item.createdAt);
    } else if (item.kind === "tool-output") {
      const turnNo = ensureTurn();
      if (!stepOpen) {
        push("step/start", { turn: turnNo, step }, undefined, item.createdAt);
        stepOpen = true;
      }
      push(
        "tool/result",
        {
          turn: turnNo,
          step,
          message: {
            id: item.id,
            role: "user",
            source: { kind: "tool", callId: item.callId },
            content: [
              {
                type: "tool-result",
                toolCallId: item.callId,
                content: item.output,
                isError: false,
              },
            ],
          },
        },
        "append",
        item.createdAt
      );
    }
  }

  if (turnOpen) {
    closeStep(turn - 1);
    push("turn/end", { turn: turn - 1, reason: { kind: "completed" } }, undefined, lastCreatedAt);
  }
  if (Number.isInteger(sequenceCeiling) && sequenceCeiling >= events.length - 1) {
    const firstSeq = sequenceCeiling - events.length + 1;
    for (let index = 0; index < events.length; index += 1) {
      events[index].event.seq = firstSeq + index;
    }
  }
  return events;
}

// ---- 写路径 ----

async function sessionCreate(payload, { sessionApplicationService, createSession, store }) {
  // DSH create 接受 cwd 或 workspaceId；Corptie 的 createSession 需要 providerId。
  // providerId 缺省走默认 provider（与现有 /sessions 创建一致，由上层兜底）。
  const requestedWorkspaceId = typeof payload?.workspaceId === "string"
    ? payload.workspaceId.trim()
    : "";
  const candidates = requestedWorkspaceId && store
    ? (store.listSessions({ archived: false }) ?? [])
      .filter((session) => session.workId === requestedWorkspaceId && session.agentId)
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    : [];
  const inheritedSession = candidates[0] ?? null;
  // A Work owns one stable Work Chat. DSH asks session.create when mounting an
  // empty conversation surface, but for a Work scope that operation means
  // attach to the existing business Session, not create a second Provider
  // Session and collide with the Work Chat uniqueness constraint.
  if (inheritedSession?.sessionKind === "workChat") {
    return { sessionId: inheritedSession.id };
  }
  const cwd = typeof payload?.cwd === "string"
    ? payload.cwd
    : inheritedSession?.external?.cwd;
  const actorId = inheritedSession?.agentId ?? null;
  if (typeof createSession !== "function") {
    throw new Error("session.create is unavailable without the unified Session factory");
  }
  if (!actorId) {
    const error = new Error("session.create requires an existing Agent in the selected Corptie Work");
    error.code = "AGENT_REQUIRED";
    throw error;
  }
  const session = await createSession({
    ...(cwd ? { cwd } : {}),
    ...(inheritedSession?.sessionKind ? { sessionKind: inheritedSession.sessionKind } : {})
  }, {
    actorId,
    workId: requestedWorkspaceId || inheritedSession?.workId || null,
    sessionKind: inheritedSession?.sessionKind ?? null
  });
  const sessionId = session?.publicSessionId ?? session?.sessionId ?? session?.id;
  if (!sessionId) throw new Error("session.create returned no session id");
  return { sessionId };
}

export async function sessionPrompt(payload, { sessionApplicationService, sendSessionMessage }) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw notFound(sessionId);

  // DSH content 是 PromptContentPart[]（{type:'text'|'image', ...}）；取文本部分拼成消息。
  const text = extractPromptText(payload?.content);
  if (!text) throw new Error("session.prompt requires text content");

  if (typeof sendSessionMessage === "function") {
    await sendSessionMessage(sessionId, text);
  } else {
    await sessionApplicationService.sendMessage(sessionId, text, { source: { type: "dsh" } });
  }
  return { accepted: true };
}

async function sessionCancel(payload, { sessionApplicationService }) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw notFound(sessionId);
  await sessionApplicationService.interrupt(sessionId, { source: "dsh" });
  return { accepted: true };
}

async function sessionRename(payload, { sessionApplicationService }) {
  const sessionId = String(payload?.sessionId ?? "");
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  if (!sessionId) throw notFound(sessionId);
  if (!title) throw new Error("session.rename requires title");
  const renamed = await sessionApplicationService.renameSession(sessionId, title, { source: "dsh" });
  // DSH rename 返回 { title, seq }：title 是 host 归一化后的标题，seq 是标题事件序列号
  // （前端 ProjectionValueStore 按 higher-seq-wins 合并，seq 必须单调递增才能覆盖旧标题）。
  // Corptie 无独立标题事件 seq，用重命名后的 updatedAt epoch 毫秒作为 seq（rename 会刷新
  // updated_at，毫秒级单调递增）。provider 返回结构不统一，优先取返回对象的 title/updatedAt，
  // 取不到则回退到入参 title + 当前时间。
  const normalizedTitle = typeof renamed?.title === "string" && renamed.title.trim()
    ? renamed.title.trim()
    : title;
  const seq = toEpochMsSafe(renamed?.updatedAt) || Date.now();
  return { title: normalizedTitle, seq };
}

/** ISO 8601 → epoch 毫秒；非法返回 0（让调用方回退到 Date.now()）。 */
function toEpochMsSafe(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export async function sessionModels(payload, { sessionApplicationService }) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw notFound(sessionId);
  const catalog = await sessionApplicationService.listModelsForSession(sessionId, { source: "dsh" });
  const models = catalog.models.map(mapDshModel).filter(Boolean);
  const currentModel = catalog.currentModel || models[0]?.id;
  if (!currentModel) {
    throw new Error(`No models are available for provider ${catalog.providerId}`);
  }
  return {
    current: {
      provider: catalog.providerId,
      model: currentModel,
      ...(catalog.currentReasoningLevel ? { reasoningEffort: catalog.currentReasoningLevel } : {})
    },
    routable: models.length > 0,
    groups: [{
      id: catalog.providerId,
      name: catalog.providerName || catalog.providerId,
      models
    }],
    failures: [],
  };
}

export async function sessionSelectModel(payload, { sessionApplicationService }) {
  const sessionId = String(payload?.sessionId ?? "");
  const model = typeof payload?.model === "string" ? payload.model : "";
  if (!sessionId) throw notFound(sessionId);
  if (!model) throw new Error("session.selectModel requires model");
  await sessionApplicationService.switchModel(sessionId, model, { source: "dsh" });
  const reasoningEffort = typeof payload?.reasoningEffort === "string" && payload.reasoningEffort
    ? payload.reasoningEffort
    : null;
  if (reasoningEffort) {
    await sessionApplicationService.switchReasoning(sessionId, reasoningEffort, { source: "dsh" });
  }
  return {
    selected: {
      provider: String(payload?.provider ?? "provider"),
      model,
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  };
}

function mapDshModel(model) {
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const levels = Array.isArray(model.reasoningLevels)
    ? model.reasoningLevels.filter((level) => typeof level === "string" && level)
    : [];
  return {
    id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : id,
    ...(typeof model.description === "string" && model.description ? { description: model.description } : {}),
    ...(levels.length > 0 ? {
      reasoning: {
        efforts: levels.map((level) => ({ id: level, name: level })),
        ...(model.defaultReasoningLevel ? { defaultEffort: model.defaultReasoningLevel } : {})
      }
    } : {})
  };
}

// ---- boot 握手宿主级端点 ----

/**
 * host.describe：DSH 前端 ConnectionController「严格就绪握手」的硬门槛。
 * 返回 schema（hostDescribeValueSchema）合法的最小值即可让前端越过握手、
 * 进入 connected 态。version 取任意非空字符串；cwd 取最近一个 session 的
 * cwd（无则回退 process.cwd()）；attachedSessions 用当前未归档 session 数。
 */
async function hostDescribe(_payload, { listStoredSessions }) {
  let cwd = process.cwd();
  let attachedSessions = 0;
  try {
    const sessions = await listStoredSessions({ archived: false });
    attachedSessions = Array.isArray(sessions) ? sessions.length : 0;
    // 取最近更新的 session 的 cwd（外部工作目录）作为 host cwd。
    if (Array.isArray(sessions) && sessions.length > 0) {
      const mostRecent = sessions
        .filter((s) => typeof s?.external?.cwd === "string" && s.external.cwd)
        .sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")))[0];
      if (mostRecent?.external?.cwd) cwd = mostRecent.external.cwd;
    }
  } catch {
    // listSessions 失败不影响握手：用 process.cwd() 兜底。
  }
  return {
    version: "corptie",
    cwd,
    attachedSessions,
    canOpenPath: false,
  };
}

/**
 * settings.describe：DSH 前端 ui-settings / ui-theme / locale 等 boot 时会拉取。
 * 返回 ui-onboarding 命名空间（已预置确认版本），使前端 WelcomeNotice 直接判定
 * acknowledged，不再弹内测声明或报「无法保存确认状态」。其余命名空间不提供，
 * 前端走默认配置，不阻塞渲染。
 */
export async function settingsDescribe(_payload) {
  return {
    writable: false,
    hasDocument: false,
    namespaces: [onboardingNamespaceView(WELCOME_NOTICE_NAMESPACE)],
  };
}

/**
 * settings.mutate：DSH 前端 WelcomeNoticeStore.acknowledge() 调用，保存
 * ui-onboarding.welcomeNoticeVersion。实现 set/unset（进程内持久化），返回
 * 该命名空间的新 view（settingsMutateValueSchema = settingsNamespaceViewSchema）。
 * 即便 describe 已预置确认、正常不会走到这里，也保证未来版本号变更时「继续」可成功。
 */
export async function settingsMutate(payload) {
  const ns = typeof payload?.ns === "string" && payload.ns ? payload.ns : WELCOME_NOTICE_NAMESPACE;
  const ops = Array.isArray(payload?.ops) ? payload.ops : [];

  const current = onboardingValues.get(ns) ?? {};
  const next = { ...current };
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "set" && Array.isArray(op.path) && op.path.length > 0) {
      setPath(next, op.path, op.value);
    } else if (op.op === "unset" && Array.isArray(op.path) && op.path.length > 0) {
      unsetPath(next, op.path);
    }
  }
  onboardingValues.set(ns, next);
  return onboardingNamespaceView(ns);
}

/** 按 path 设置嵌套对象字段（仅对象层级；叶子直接赋值）。 */
function setPath(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

/** 按 path 删除嵌套对象字段。 */
function unsetPath(target, path) {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) return;
    node = node[key];
  }
  delete node[path[path.length - 1]];
}

/**
 * workspace.list：DSH 前端 workspace 侧边栏 boot 时会拉取。
 * 映射 Corptie 的 Work → DSH WorkspaceView：
 *   workspaceId  ← work.id
 *   title        ← work.name
 *   sessionIds   ← 该 work 下所有未归档 session 的 id
 *   path         ← Work 唯一 Workspace 的真实目录路径（仅用于 hover 展示 + 复制，零副作用）
 *   createdAt    ← work.createdAt
 *   updatedAt    ← work.updatedAt
 *
 * 「按 Assistant 分类会话」的第二组织方式暂不实现：assistant role 当前只在
 * 协作目录（collaborator_registry）里有「不可路由」语义，agents 表无 role 写入路径，
 * 会话归属的权威来源仍是 work/task。待 assistant role 真正落地到
 * agents 表后再扩展。
 */
async function workspaceList(_payload, { store }) {
  let items = [];
  let archivedSessionIds = [];
  try {
    const works = store.listWorks() ?? [];
    const sessions = store.listSessions({ archived: false }) ?? [];

    // Work 的唯一 Workspace 提供展示路径；Task 不保存重复的 Workspace 绑定。
    const activePathByWork = new Map();
    for (const work of works) {
      const resolved = store.resolveWorkspaceRoot?.(work.workspaceId) ?? null;
      if (resolved) activePathByWork.set(work.id, resolved);
    }

    items = mapWorkspaceList(works, sessions, activePathByWork);

    const archived = store.listSessions({ archived: true });
    archivedSessionIds = (archived ?? [])
      .map((s) => s?.id)
      .filter((id) => typeof id === "string" && id);
  } catch (error) {
    // store 读取失败返回空，不阻塞握手。
    console.error("[dsh-adapter] workspace.list failed:", error?.message ?? error);
  }
  return { items, archivedSessionIds };
}

/**
 * 纯函数：Work[] + Session[] + activePath 映射 → DSH WorkspaceView[]。
 * 分离出来便于单测；session 按 workId 分组（一次性遍历，避免 N+1）。
 */
export function mapWorkspaceList(works, sessions, activePathByWork = new Map()) {
  const sessionsByWork = new Map();
  for (const s of sessions ?? []) {
    const oid = s?.workId;
    if (typeof oid !== "string" || !oid) continue;
    if (!sessionsByWork.has(oid)) sessionsByWork.set(oid, []);
    sessionsByWork.get(oid).push(s?.id);
  }
  return (works ?? []).map((obj) => ({
    workspaceId: obj.id,
    title: obj.name,
    sessionIds: sessionsByWork.get(obj.id) ?? [],
    path: activePathByWork.get(obj.id) ?? "",
    createdAt: obj.createdAt ?? "",
    updatedAt: obj.updatedAt ?? "",
  }));
}

// ---- 辅助 ----

function extractPromptText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function notFound(sessionId) {
  const err = new Error(`Session not found: ${sessionId}`);
  err.code = "SESSION_NOT_FOUND";
  err.sessionId = sessionId;
  return err;
}
