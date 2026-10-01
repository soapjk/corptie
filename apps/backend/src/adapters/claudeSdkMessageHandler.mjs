import { providerSafeToolText } from "../utils/providerRawMetadata.mjs";
import { captureClaudePlanCalls, settledClaudePlanUpdates } from "./claudePlanTools.mjs";
import {
  claudeAssistantContentItems, finalizeClaudeTurnItems, claudeTaskSubtype,
  isTerminalClaudeTaskMessage, claudeTaskBlocksTurnSettlement
} from "./claudeMessageProjection.mjs";
import { claudeSdkResultError } from "../agent-provider/providers/claudeProviderConfiguration.mjs";

// Reduces SDK messages into the existing runtime Session object. Publication,
// persistence and interaction ownership remain behind explicit manager ports.
export function createClaudeSdkMessageHandler({
  emitProviderEvent, appendItem, persistSessionIdentity, settleToolResults,
  structuredPlanEvents, appendPlanToolFallback, expireInteractions, environment,
  upsertTaskProgressItem, notifyTurnSettled
}) {
  function handleSdkMessage(session, message) {
    session.updatedAt = new Date().toISOString();
    if (message?.type === "tool_progress") {
      const id = session.pendingToolCalls?.get(message.tool_use_id);
      const item = id ? session.items.find(item => item.id === id) : null;
      const seconds = Math.floor(Number(message.elapsed_time_seconds));
      if (item && Number.isFinite(seconds) && seconds >= 0 && item.elapsedSeconds !== seconds
        && !["completed", "failed", "cancelled"].includes(item.status)) {
        item.elapsedSeconds = seconds;
        item.presentationText = `${item.text ?? ""}\n已执行 ${seconds} 秒`;
        emitProviderEvent(session, { type: "execution.notice", turnId: item.turnId,
          itemId: item.id, item, occurredAt: session.updatedAt });
      }
      return;
    }
    if (message?.type === "tool_use_summary" || message?.type === "auth_status"
      || (message?.type === "system" && message.subtype === "compact_boundary")) {
      const id = `${session.id}:notice:${message.uuid ?? `${session.currentTurnId}:${message.type}:${message.subtype ?? ""}`}`;
      if (session.items.some(item => item.id === id)) return;
      const compact = message.subtype === "compact_boundary";
      const auth = message.type === "auth_status";
      // Authentication output can contain credentials. Never persist it.
      const text = compact ? "上下文已压缩"
        : auth ? (message.error ? "认证失败，请检查 Provider 登录状态。" : message.isAuthenticating ? "正在认证" : "认证流程已结束")
          : providerSafeToolText(String(message.summary ?? "")).slice(0, 4000);
      appendItem(session, { id, type: compact ? "contextCompaction" : "system",
        title: compact ? "上下文压缩" : auth ? "认证状态" : "执行摘要",
        text, status: message.error ? "failed" : "completed", neutralNotice: true });
      return;
    }
    console.log(`[claude-sdk] message id=${session.id} type=${message?.type ?? "unknown"} subtype=${message?.subtype ?? ""}`);
    if (message?.session_id && !session.agentSessionId) {
      session.agentSessionId = message.session_id;
      persistSessionIdentity(session);
    }

    if (message?.type === "system" && message?.subtype === "init") {
      session.agentSessionId = message.session_id ?? session.agentSessionId;
      persistSessionIdentity(session);
      session.currentModel = message.model ?? session.currentModel;
      session.phase = "ready";
      return;
    }

    if (message?.type === "stream_event") {
      handleStreamEvent(session, message);
      return;
    }

    if (message?.type === "user") {
      settleToolResults(session, message);
      if (structuredPlanEvents()) {
        for (const update of settledClaudePlanUpdates(message, session.pendingPlanCalls ?? new Map(), (call, reason) => {
          appendPlanToolFallback(session, call, reason);
        })) {
          emitProviderEvent(session, {
            type: "plan.updated",
            providerEventId: `claude-plan:${message.uuid ?? update.sourceCallId}:${update.sourceCallId}`,
            turnId: update.turnId,
            plan: update.plan,
            occurredAt: message.timestamp ?? session.updatedAt
          });
        }
      }
      return;
    }

    if (message?.type === "assistant") {
      if (structuredPlanEvents()) {
        session.pendingPlanCalls ??= new Map();
        captureClaudePlanCalls(message, session.pendingPlanCalls, session.currentTurnId,
          (call) => appendPlanToolFallback(session, call, "unavailable"));
      }
      if (session.lastResult && session.turnState !== "running") {
        // A foreground result is not necessarily the end of the Query. Claude
        // can continue streaming assistant/tool events from a background Agent.
        session.deferredResult = session.lastResult;
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      }
      const items = claudeAssistantContentItems(message.message, structuredPlanEvents());
      const belongsToSubagent = typeof message.parent_tool_use_id === "string"
        && message.parent_tool_use_id.trim().length > 0;
      if (items.length > 0) {
        session.lastOutputAt = session.updatedAt;
        const finalText = items.filter((item) => item.type === "agentMessage")
          .map((item) => item.text)
          .join("\n\n")
          .trim();
        if (session.streamingAssistant && finalText) {
          updateStreamingAssistant(session, finalText, {
            completed: true,
            providerMessageId: message.uuid,
            excludeFromFinal: belongsToSubagent
          });
        } else {
          for (const item of items.filter((item) => item.type === "agentMessage")) {
            const appended = appendItem(session, { ...item, presentationRole: "commentary",
              rawMetadataJSON: JSON.stringify({
                forkPoint: { messageId: message.uuid },
                ...(belongsToSubagent ? { parentToolUseId: message.parent_tool_use_id } : {})
              }) });
            if (belongsToSubagent) {
              session.toolContinuationItemIds ??= new Set();
              session.toolContinuationItemIds.add(appended.id);
            }
          }
        }
        for (const item of items.filter((item) => item.type !== "agentMessage")) {
          const appended = appendItem(session, item);
          if (item.toolUseId) {
            session.pendingToolCalls ??= new Map();
            if (session.pendingToolCalls.size >= 256) session.pendingToolCalls.delete(session.pendingToolCalls.keys().next().value);
            session.pendingToolCalls.set(item.toolUseId, appended.id);
          }
        }
        if (finalText && message.message?.stop_reason === "tool_use") {
          const lastText = session.items.findLast(item => item.turnId === session.currentTurnId && item.type === "agentMessage");
          if (lastText) lastText.presentationRole = "commentary";
          session.toolContinuationItemIds ??= new Set();
          if (lastText) session.toolContinuationItemIds.add(lastText.id);
        }
      }
      return;
    }

    if (message?.type === "result") {
      expireInteractions(session);
      const failure = claudeSdkResultError(message, {
        secretValues: [environment()?.ANTHROPIC_API_KEY].filter(Boolean)
      });
      const text = failure?.message
        ?? (typeof message.result === "string" ? message.result.trim() : "");
      session.pendingChoice = null;
      session.pendingDecision = null;
      session.pendingChoices?.clear();
      const wasInterrupted = session.interruptRequested === true;
      session.interruptRequested = false;
      const result = {
        turnId: session.currentTurnId,
        succeeded: !failure || wasInterrupted,
        text,
        failure,
        notified: false
      };
      session.lastResult = result;
      if (text && !result.succeeded) {
        session.lastOutputAt = session.updatedAt;
        appendItem(session, {
          type: "system",
          title: "Claude Code",
          text,
          status: message.subtype || "result"
        });
      }
      if (session.activeTaskIds.size > 0) {
        session.deferredResult = result;
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      } else {
        settleClaudeResult(session, result);
      }
      return;
    }

    if (message?.type === "status") {
      session.phase = message.status || session.phase;
      if (message.status === "requesting" || message.status === "compacting") {
        session.turnState = "running";
      }
      return;
    }

    if (message?.type === "session_state_changed") {
      session.turnState = message.state || session.turnState;
      session.phase = message.state || session.phase;
      return;
    }

    const taskSubtype = claudeTaskSubtype(message);
    if (taskSubtype) {
      const taskId = String(message?.task_id ?? message?.tool_use_id ?? "").trim();
      const terminal = isTerminalClaudeTaskMessage(message, taskSubtype);
      const blocksTurnSettlement = claudeTaskBlocksTurnSettlement(message);
      if (taskId) {
        if (terminal) session.activeTaskIds.delete(taskId);
        else if (blocksTurnSettlement) session.activeTaskIds.add(taskId);
      }
      if (!terminal && (!session.lastResult || blocksTurnSettlement)) {
        if (session.lastResult && !session.deferredResult) {
          session.deferredResult = session.lastResult;
        }
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      }
      if (taskId && message?.skip_transcript === true) session.hiddenTaskIds.add(taskId);
      if (taskId && !session.hiddenTaskIds.has(taskId)) {
        upsertTaskProgressItem(session, message, taskId, terminal);
      }
      if (terminal) session.hiddenTaskIds.delete(taskId);
      if (terminal && session.deferredResult) {
        // A task notification is fed back into Claude's primary loop. The SDK
        // can emit more assistant/tool activity before the continuation result,
        // so the last task ending is not a product Turn terminal boundary.
        session.turnState = "running";
        session.status = "running";
        session.phase = "working";
      }
      return;
    }

    if (message?.type === "informational" || message?.type === "permission_denied") {
      const text = message.message || message.content || message.permission_denial_reason || "";
      if (text) {
        appendItem(session, {
          type: message?.type === "permission_denied" ? "warning" : "mcpToolCall",
          title: "Claude Code",
          text: String(text)
        });
      }
      return;
    }
  }

  function settleClaudeResult(session, result) {
    for (const call of session.pendingPlanCalls?.values() ?? []) {
      if (call.turnId === result.turnId) appendPlanToolFallback(session, call, "unavailable");
    }
    session.pendingPlanCalls?.clear();
    session.pendingToolCalls?.clear();
    session.deferredResult = null;
    session.turnState = "idle";
    session.phase = result.succeeded ? "ready" : "failed";
    session.status = result.succeeded ? "complete" : "failed";
    finalizeClaudeTurnItems(
      session,
      result.turnId,
      result.succeeded ? "complete" : "failed"
    );
    if (!result.notified) {
      result.notified = true;
      notifyTurnSettled(session, {
        turnId: result.turnId,
        status: result.succeeded ? "completed" : "failed",
        error: result.succeeded ? null : {
          code: result.failure?.code ?? "CLAUDE_REQUEST_FAILED",
          message: result.text,
          retryable: result.failure?.retryable === true
        }
      });
    }
  }

  function handleStreamEvent(session, message) {
    const event = message?.event;
    if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
      const delta = typeof event.delta.text === "string" ? event.delta.text : "";
      if (!delta) return;
      const nextText = `${session.streamingAssistant?.text ?? ""}${delta}`;
      updateStreamingAssistant(session, nextText, {
        excludeFromFinal: typeof message.parent_tool_use_id === "string"
          && message.parent_tool_use_id.trim().length > 0
      });
    }
  }

  function updateStreamingAssistant(session, text, options = {}) {
    const value = String(text ?? "");
    if (!value) return null;
    const existing = session.streamingAssistant;
    if (!existing) {
      const item = appendItem(session, {
        // A Turn can contain many assistant messages separated by tool calls.
        // Only deltas of this message share an id, never the entire Turn.
        id: `${session.id}:stream:${session.currentTurnId ?? session.nextTurnSeq}:${session.nextItemSeq}`,
        type: "agentMessage",
        title: "Claude Code",
        text: value,
        ...(options.providerMessageId ? { rawMetadataJSON: JSON.stringify({ forkPoint: { messageId: options.providerMessageId } }) } : {}),
        presentationRole: "commentary"
      });
      session.streamingAssistant = options.completed === true ? null : { itemId: item.id, text: value };
      if (options.excludeFromFinal === true) {
        session.toolContinuationItemIds ??= new Set();
        session.toolContinuationItemIds.add(item.id);
      }
      return item;
    }
    const index = session.items.findIndex((item) => item.id === existing.itemId);
    if (index < 0) {
      session.streamingAssistant = null;
      return updateStreamingAssistant(session, value, options);
    }
    const item = {
      ...session.items[index],
      text: value,
      ...(options.providerMessageId ? { rawMetadataJSON: JSON.stringify({
        ...JSON.parse(session.items[index].rawMetadataJSON ?? "{}"),
        forkPoint: { messageId: options.providerMessageId }
      }) } : {}),
      // SDK assistant completion closes a message, not the product Turn.
      // Formal-answer promotion happens only when the Turn settles.
      presentationRole: "commentary"
    };
    session.items[index] = item;
    if (options.excludeFromFinal === true) {
      session.toolContinuationItemIds ??= new Set();
      session.toolContinuationItemIds.add(item.id);
    }
    session.streamingAssistant = options.completed === true
      ? null
      : { itemId: item.id, text: value };
    emitProviderEvent(session, {
      type: options.completed === true ? "assistant.message.completed" : "assistant.message.delta",
      turnId: item.turnId,
      itemId: item.id,
      item,
      occurredAt: session.updatedAt
    });
    return item;
  }

  return { handleSdkMessage, settleClaudeResult, handleStreamEvent, updateStreamingAssistant };
}
