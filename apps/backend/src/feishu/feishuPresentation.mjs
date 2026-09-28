import os from "node:os";
import { collaborationConfirmationStatus } from "./feishuDeliveryPolicy.mjs";

export const sessionCardPageSize = 5;
export const workspaceCardPageSize = 5;

export function buildSessionListCard({
  botId,
  sessions = [],
  assignments = [],
  current = null,
  page = 0,
  pageSize = sessionCardPageSize,
  notice = null
}) {
  const ownerBySession = new Map(assignments.map((item) => [item.sessionId, item]));
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePage = Math.min(nonNegativeInteger(page), pageCount - 1);
  const visibleSessions = sessions.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const elements = [];

  if (notice?.text) {
    const color = notice.type === "error" ? "red" : notice.type === "success" ? "green" : "blue";
    elements.push({
      tag: "markdown",
      content: `<font color='${color}'>${escapeCardMarkdown(notice.text)}</font>`
    });
  }

  if (visibleSessions.length === 0) {
    elements.push({
      tag: "markdown",
      content: "这台电脑上暂时没有可用会话。打开 Corptie 创建会话后，再点击下方刷新按钮。"
    });
  }

  for (const session of visibleSessions) {
    const owner = ownerBySession.get(session.id);
    const isCurrent = current?.sessionId === session.id;
    const isOccupied = Boolean(owner && owner.botId !== botId);
    const state = isCurrent ? "已连接" : isOccupied ? "其他机器人已占用" : displayStatus(session.status);
    const buttonText = isCurrent ? "已连接" : isOccupied ? "不可用" : "连接";
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: isCurrent ? "blue-50" : "grey-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          padding: "10px 8px 10px 12px",
          vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${escapeCardMarkdown(session.title || "未命名会话")}**` },
            {
              tag: "markdown",
              content: `<font color='grey'>${escapeCardMarkdown(state)}</font>`,
              text_size: "notation"
            },
            {
              tag: "markdown",
              content: `<font color='grey'>Agent：${escapeCardMarkdown(session.agentName || "未绑定")}</font>`,
              text_size: "notation"
            },
            ...(session.taskTitle ? [{
              tag: "markdown",
              content: `<font color='grey'>Task：${escapeCardMarkdown(session.taskTitle)}</font>`,
              text_size: "notation"
            }] : [])
          ]
        },
        {
          tag: "column",
          width: "auto",
          padding: "10px 12px 10px 4px",
          vertical_align: "center",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: buttonText },
            type: isCurrent ? "primary" : "primary_filled",
            disabled: isCurrent || isOccupied,
            ...((isCurrent || isOccupied) ? {
              disabled_tips: {
                tag: "plain_text",
                content: isOccupied ? "同一个会话只能连接一个飞书机器人" : "当前机器人已连接此会话"
              }
            } : {}),
            behaviors: [{
              type: "callback",
              value: {
                corptie_action: "select_session",
                session_id: session.id,
                page: safePage
              }
            }]
          }]
        }
      ]
    });
  }

  const navigation = [];
  if (safePage > 0) navigation.push(cardActionButton("上一页", "sessions_page", safePage - 1));
  navigation.push(cardActionButton("刷新", "refresh_sessions", safePage));
  if (safePage < pageCount - 1) navigation.push(cardActionButton("下一页", "sessions_page", safePage + 1, true));
  if (current) navigation.push(cardActionButton("释放会话", "detach_session", safePage));
  elements.push(cardButtonRow([cardActionButton("新建会话", "start_create_session", 0, true)]));
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    columns: navigation.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [button]
    }))
  });

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: "选择 Corptie 会话" }
    },
    header: {
      title: { tag: "plain_text", content: "Corptie 会话" },
      subtitle: {
        tag: "plain_text",
        content: sessions.length ? `选择后直接连接 · ${safePage + 1}/${pageCount}` : "等待本机会话"
      },
      template: current ? "turquoise" : "blue"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      vertical_spacing: "10px",
      elements
    }
  };
}

export function buildWorkspacePickerCard({
  workspaces = [],
  page = 0,
  pageSize = workspaceCardPageSize,
  notice = null
}) {
  const pageCount = Math.max(1, Math.ceil(workspaces.length / pageSize));
  const safePage = Math.min(nonNegativeInteger(page), pageCount - 1);
  const visible = workspaces.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  if (visible.length === 0) {
    elements.push({
      tag: "markdown",
      content: "还没有可信工作区。请先在电脑端创建一个会话；它使用过的项目目录会自动出现在这里。"
    });
  }
  for (const workspace of visible) {
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: "grey-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          padding: "10px 8px 10px 12px",
          vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${escapeCardMarkdown(workspace.name)}**` },
            { tag: "markdown", content: `<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`, text_size: "notation" }
          ]
        },
        {
          tag: "column",
          width: "auto",
          padding: "10px 12px 10px 4px",
          vertical_align: "center",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: "选择" },
            type: "primary_filled",
            behaviors: [{
              type: "callback",
              value: { corptie_action: "select_workspace", workspace_id: workspace.id, page: safePage }
            }]
          }]
        }
      ]
    });
  }
  const navigation = [];
  if (safePage > 0) navigation.push(cardActionButton("上一页", "workspaces_page", safePage - 1));
  navigation.push(cardActionButton("刷新", "refresh_workspaces", safePage));
  if (safePage < pageCount - 1) navigation.push(cardActionButton("下一页", "workspaces_page", safePage + 1, true));
  navigation.push(cardActionButton("返回会话", "create_back_sessions", 0));
  elements.push(cardButtonRow(navigation));
  return cardShell({
    title: "选择项目",
    subtitle: workspaces.length ? `可信工作区 · ${safePage + 1}/${pageCount}` : "需要先在电脑端使用项目",
    template: "blue",
    summary: "选择新会话的项目目录",
    elements
  });
}

export function buildAgentPickerCard({ workspace, notice = null }) {
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  elements.push({
    tag: "markdown",
    content: `项目：**${escapeCardMarkdown(workspace.name)}**\n<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`
  });
  elements.push(cardButtonRow([
    gatewayActionButton("Codex", "select_create_agent", {
      workspace_id: workspace.id,
      agent: "codex"
    }, true),
    gatewayActionButton("Claude Code", "select_create_agent", {
      workspace_id: workspace.id,
      agent: "claude"
    })
  ]));
  elements.push(cardButtonRow([
    gatewayActionButton("返回项目", "create_back_workspaces"),
    gatewayActionButton("取消", "create_cancel")
  ]));
  return cardShell({
    title: "选择 Agent",
    subtitle: workspace.name,
    template: "indigo",
    summary: "选择新会话使用的 Agent",
    elements
  });
}

export function buildCreateConfirmationCard({ workspace, agent, replacesCurrentSession = false, notice = null }) {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  elements.push({
    tag: "markdown",
    content: [
      `**项目**：${escapeCardMarkdown(workspace.name)}`,
      `**Agent**：${label}`,
      `<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`,
      replacesCurrentSession ? "\n<font color='orange'>创建后，机器人将从当前会话切换到新会话。</font>" : ""
    ].filter(Boolean).join("\n")
  });
  elements.push(cardButtonRow([
    gatewayActionButton("创建并连接", "confirm_create_session", {
      workspace_id: workspace.id,
      agent
    }, true),
    gatewayActionButton("返回", "select_workspace", { workspace_id: workspace.id }),
    gatewayActionButton("取消", "create_cancel")
  ]));
  return cardShell({
    title: "确认创建会话",
    subtitle: `${workspace.name} · ${label}`,
    template: "turquoise",
    summary: "确认创建并连接 Corptie 会话",
    elements
  });
}

function cardShell({ title, subtitle, template, summary, elements }) {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: summary } },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      template
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      vertical_spacing: "10px",
      elements
    }
  };
}

function cardButtonRow(buttons) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: buttons.map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] }))
  };
}

function gatewayActionButton(label, action, extra = {}, primary = false) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: [{ type: "callback", value: { corptie_action: action, ...extra } }]
  };
}

function noticeMarkdown(notice) {
  const color = notice.type === "error" ? "red" : notice.type === "success" ? "green" : "blue";
  return { tag: "markdown", content: `<font color='${color}'>${escapeCardMarkdown(notice.text)}</font>` };
}

export function buildApprovalCard({ sessionId, sessionTitle = "", item }) {
  const options = Array.isArray(item?.options) ? item.options.slice(0, 5) : [];
  const body = optionalText(item?.text) || "Codex 请求执行一项需要授权的操作。";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: "Codex 正在等待权限审批" }
    },
    header: {
      title: {
        tag: "plain_text",
        content: optionalText(sessionTitle) || "Corptie · 需要权限审批"
      },
      ...(optionalText(sessionTitle) ? {
        subtitle: { tag: "plain_text", content: "Corptie · 需要权限审批" }
      } : {}),
      template: "orange"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [
        { tag: "markdown", content: body },
        cardButtonRow(options.map((option) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: optionalText(option.label)
              || (String(option.role ?? "").toLowerCase().includes("deny") ? "拒绝" : "允许")
          },
          type: String(option.role ?? "").toLowerCase().includes("deny") ? "default" : "primary_filled",
          width: "fill",
          behaviors: [{
            type: "callback",
            value: {
              corptie_action: "respond_approval",
              session_id: sessionId,
              choice_id: item.id,
              item_type: item.type,
              option_id: option.id,
              option_index: option.index ?? 0,
              option_role: option.role ?? ""
            }
          }]
        })))
      ]
    }
  };
}

export function buildCollaborationConfirmationCard({ sessionId, sessionTitle = "", item }) {
  const status = collaborationConfirmationStatus(item) || "pending";
  const pending = status === "pending";
  const confirmed = status === "confirmed";
  const sourceSession = readableCollaborationName(
    item?.collaborationInitiatorSessionTitle,
    item?.collaborationInitiatorSessionId,
    "来源会话"
  );
  const targetSession = readableCollaborationName(
    item?.collaborationRecipientSessionTitle,
    item?.collaborationRecipientSessionId,
    "目标会话"
  );
  const sourceWork = readableCollaborationName(
    item?.collaborationSourceWorkName,
    item?.collaborationSourceWorkId,
    "来源 Work"
  );
  const targetWork = readableCollaborationName(
    item?.collaborationTargetWorkName,
    item?.collaborationTargetWorkId,
    "目标 Work"
  );
  const hasTargetSession = Boolean(optionalText(item?.collaborationRecipientSessionId));
  const taskTitle = optionalText(item?.collaborationRequestTitle);
  const instruction = optionalText(item?.presentationText) || "等待确认发送协作任务。";
  const criteria = Array.isArray(item?.collaborationAcceptanceCriteria)
    ? item.collaborationAcceptanceCriteria.map(optionalText).filter(Boolean)
    : [];
  const elements = [
    { tag: "markdown", content: `**来源会话 → 目标会话**\n${escapeCardMarkdown(sourceSession)} → ${escapeCardMarkdown(hasTargetSession ? targetSession : "确认后创建新的 Task 和目标会话")}` },
    { tag: "markdown", content: `**来源 Work → 目标 Work**\n${escapeCardMarkdown(sourceWork)} → ${escapeCardMarkdown(targetWork)}` },
    ...(!hasTargetSession && taskTitle ? [{ tag: "markdown", content: `**将创建 Task**\n${escapeCardMarkdown(taskTitle)}` }] : []),
    { tag: "markdown", content: `**消息**\n${escapeCardMarkdown(instruction)}` },
    ...(criteria.length ? [{
      tag: "markdown",
      content: `**验收标准**\n${criteria.map((criterion) => `- ${escapeCardMarkdown(criterion)}`).join("\n")}`
    }] : [])
  ];
  if (pending) {
    elements.push(cardButtonRow([
      gatewayActionButton("确认发送", "respond_collaboration_confirmation", {
        session_id: sessionId,
        confirmation_id: item.collaborationConfirmationId,
        decision: "confirm"
      }, true),
      gatewayActionButton("取消", "respond_collaboration_confirmation", {
        session_id: sessionId,
        confirmation_id: item.collaborationConfirmationId,
        decision: "reject"
      })
    ]));
  } else {
    elements.push({
      tag: "markdown",
      content: confirmed ? "<font color='green'>已确认发送</font>" : "<font color='grey'>已取消</font>"
    });
  }
  return cardShell({
    title: optionalText(sessionTitle) || "确认发送协作任务",
    subtitle: pending ? "Corptie · 确认发送协作任务" : (confirmed ? "Corptie · 协作任务已发送" : "Corptie · 协作任务已取消"),
    template: pending ? "orange" : (confirmed ? "green" : "grey"),
    summary: pending ? `确认从 ${sourceSession} 向 ${hasTargetSession ? targetSession : targetWork} 发起协作` : (confirmed ? "协作任务已确认发送" : "协作任务已取消"),
    elements
  });
}

export function buildCollaborationMessageCard({ sessionTitle = "", item }) {
  const sourceSession = readableCollaborationName(
    item?.collaborationInitiatorSessionTitle,
    item?.collaborationInitiatorSessionId,
    "来源会话"
  );
  const targetSession = readableCollaborationName(
    item?.collaborationRecipientSessionTitle,
    item?.collaborationRecipientSessionId,
    "目标会话"
  );
  const sourceWork = readableCollaborationName(
    item?.collaborationSourceWorkName,
    item?.collaborationSourceWorkId,
    "来源 Work"
  );
  const targetWork = readableCollaborationName(
    item?.collaborationTargetWorkName,
    item?.collaborationTargetWorkId,
    "目标 Work"
  );
  const taskTitle = optionalText(item?.collaborationRequestTitle);
  const body = optionalText(item?.presentationText) || optionalText(item?.text) || "收到一条跨会话协作消息。";
  return cardShell({
    title: optionalText(sessionTitle) || "跨会话协作",
    subtitle: `Corptie · 来自 ${sourceSession}`,
    template: "turquoise",
    summary: taskTitle || plainTextSummary(body),
    elements: [
      { tag: "markdown", content: `**来源会话 → 目标会话**\n${escapeCardMarkdown(sourceSession)} → ${escapeCardMarkdown(targetSession)}` },
      { tag: "markdown", content: `**来源 Work → 目标 Work**\n${escapeCardMarkdown(sourceWork)} → ${escapeCardMarkdown(targetWork)}` },
      ...(taskTitle ? [{ tag: "markdown", content: `**任务**\n${escapeCardMarkdown(taskTitle)}` }] : []),
      { tag: "markdown", content: `**消息**\n${escapeCardMarkdown(body)}` }
    ]
  });
}

function readableCollaborationName(name, id, fallback) {
  const value = optionalText(name);
  const stableId = optionalText(id);
  if (!value || value === stableId || /^(session|work|task):/i.test(value)) return fallback;
  return value;
}

export function buildCollaborationConfirmationResultCard(message, succeeded) {
  return cardShell({
    title: succeeded ? "Corptie · 协作任务已发送" : "Corptie · 协作确认结果",
    subtitle: succeeded ? "操作成功" : "操作未完成",
    template: succeeded ? "green" : "grey",
    summary: message,
    elements: [{ tag: "markdown", content: escapeCardMarkdown(message) }]
  });
}

export function buildSessionItemCard(item, { sessionTitle = "", sessionStatus = "" } = {}) {
  const content = optionalText(item?.presentationText)
    || optionalText(item?.text)
    || optionalText(item?.title)
    || "Corptie 消息";
  return buildMessageCard(content, { sessionTitle, sessionStatus });
}

export function buildApprovalResultCard(message, approved) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: message }
    },
    header: {
      title: { tag: "plain_text", content: approved ? "Corptie · 已允许" : "Corptie · 审批结果" },
      template: approved ? "green" : "grey"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [{ tag: "markdown", content: message }]
    }
  };
}

export function formatUsageText(usage = {}) {
  if (usage.available === false) {
    return optionalText(usage.message) || "当前模型暂时没有可查询的用量余额。";
  }

  const buckets = Object.entries(usage.rateLimitsByLimitId ?? {})
    .filter(([, snapshot]) => snapshot && typeof snapshot === "object");
  if (buckets.length === 0 && usage.rateLimits) {
    buckets.push([usage.rateLimits.limitId || "codex", usage.rateLimits]);
  }
  if (buckets.length === 0) {
    return "Codex 暂未返回可用的额度信息。";
  }

  const lines = ["**模型用量余额**"];
  if (optionalText(usage.model)) {
    lines.push(`当前模型：${usage.model}`);
  }
  const planType = buckets.map(([, snapshot]) => snapshot.planType).find(Boolean);
  if (planType) {
    lines.push(`账户计划：${displayPlanType(planType)}`);
  }

  for (const [limitId, snapshot] of buckets) {
    const name = optionalText(snapshot.limitName) || displayLimitId(snapshot.limitId || limitId);
    lines.push("", `**${name}**`);
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    for (const window of windows) {
      const used = clampPercentage(window.usedPercent);
      const remaining = clampPercentage(100 - used);
      const reset = formatResetTime(window.resetsAt);
      lines.push(`- ${formatWindowDuration(window.windowDurationMins)}：剩余 **${formatPercentage(remaining)}%**（已用 ${formatPercentage(used)}%）${reset ? ` · ${reset} 重置` : ""}`);
    }
    if (snapshot.credits?.unlimited) {
      lines.push("- Credits：无限");
    } else if (snapshot.credits?.balance != null) {
      lines.push(`- Credits 余额：${snapshot.credits.balance}`);
    }
    if (windows.length === 0 && !snapshot.credits?.unlimited && snapshot.credits?.balance == null) {
      lines.push("- 暂无可显示的额度窗口");
    }
  }
  return lines.join("\n");
}

function displayLimitId(value) {
  const text = optionalText(value);
  if (!text || text === "codex") return "Codex";
  return text.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function displayPlanType(value) {
  return ({
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Education"
  })[value] ?? String(value);
}

function formatWindowDuration(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return "额度窗口";
  if (minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatResetTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(seconds * 1000));
}

function clampPercentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

function formatPercentage(value) {
  return Number(value.toFixed(1)).toString();
}

export function buildMessageCard(text, { sessionTitle = "", sessionStatus = "" } = {}) {
  const content = String(text ?? "").trim() || " ";
  const tone = optionalText(sessionStatus)
    ? sessionStatusTone(sessionStatus)
    : messageTone(content);
  const title = optionalText(sessionTitle);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: plainTextSummary(content) }
    },
    header: {
      title: { tag: "plain_text", content: title || tone.title },
      ...(title ? { subtitle: { tag: "plain_text", content: tone.title } } : {}),
      template: tone.template
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [{ tag: "markdown", content }]
    }
  };
}

function sessionStatusTone(status) {
  const normalized = optionalText(status).toLowerCase();
  const title = `Corptie · ${displayStatus(status)}`;
  if (/failed|error/.test(normalized)) return { title, template: "red" };
  if (/completed|complete|succeeded|success/.test(normalized)) return { title, template: "green" };
  if (/waiting|approval|input/.test(normalized)) return { title, template: "orange" };
  if (/running|processing|working|connecting/.test(normalized)) return { title, template: "blue" };
  return { title, template: "grey" };
}

function messageTone(content) {
  if (/失败|错误|无效|过期|不可用|error|failed/i.test(content)) {
    return { title: "Corptie · 操作未完成", template: "red" };
  }
  if (/已完成|完成$|成功|已连接/.test(content)) {
    return { title: "Corptie · 已完成", template: "green" };
  }
  if (/正在|处理中|已排队|等待/.test(content)) {
    return { title: "Corptie · 进行中", template: "blue" };
  }
  return { title: "Corptie", template: "indigo" };
}

function plainTextSummary(content) {
  const text = content
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/[*_`#>\[\]()|~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 120) || "Corptie 消息";
}

function cardActionButton(label, action, page, primary = false) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: [{
      type: "callback",
      value: { corptie_action: action, page }
    }]
  };
}

function compactPath(path) {
  const value = optionalText(path);
  if (!value) return "";
  const home = os.homedir();
  const compact = value === home ? "~" : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
  return compact.length > 52 ? `…${compact.slice(-51)}` : compact;
}

function escapeCardMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

export function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function displayStatus(status) {
  return ({
    idle: "空闲",
    running: "正在处理",
    queued: "已排队",
    processing: "正在处理",
    blocked: "等待用户",
    waiting_for_approval: "等待审批",
    waiting_for_input: "等待输入",
    complete: "已完成",
    completed: "已完成",
    cancelled: "已停止",
    interrupted: "已停止",
    failed: "失败"
  })[status] ?? status ?? "未知";
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}
