import { createHash } from "node:crypto";
import { createdAtFromOrNow } from "../utils/timestamps.mjs";
import { providerRawMetadataJSON } from "../utils/providerRawMetadata.mjs";
import { toolExecutionForItem, withToolExecutionMetadata } from "../utils/toolExecutionProjection.mjs";
import { changeSetForClaudeTool, withChangeSetMetadata } from "../utils/changeSetProjection.mjs";
import { claudeToolResultPreview, claudeStructuredToolResult, taskMessageText } from "./claudeMessageProjection.mjs";

// One mutation boundary for native runtime items and their correlated tool
// results. Uses the existing Session arrays and the configured retention limit.
export function createClaudeTimelineWriter({ maxItems, emitProviderEvent }) {
  function appendItem(session, item) {
    const createdAt = createdAtFromOrNow(item);
    const appendedItem = {
      id: item.id ?? `${session.id}:${session.nextItemSeq}`,
      turnId: item.turnId ?? session.currentTurnId ?? session.id,
      turnStatus: session.status,
      type: item.type,
      title: item.title,
      text: item.text,
      options: item.options ?? null,
      ...(item.userInput ? { userInput: item.userInput } : {}),
      ...(item.neutralNotice ? { neutralNotice: true } : {}),
      status: item.status ?? null,
      toolUseId: item.toolUseId ?? null,
      changeSet: item.changeSet ?? null,
      createdAt,
      presentationRole: item.presentationRole ?? null,
      presentationText: item.presentationText ?? null,
      rawMetadataJSON: item.rawMetadataJSON ?? providerRawMetadataJSON(
        "claude-sdk",
        item.rawPayload ?? item,
        { source: item.rawPayload ? "provider_event" : "normalized_item" }
      )
    };
    if (appendedItem.toolUseId) {
      appendedItem.rawMetadataJSON = withToolExecutionMetadata(
        appendedItem.rawMetadataJSON,
        toolExecutionForItem(appendedItem, { input: appendedItem.text })
      );
    }
    appendedItem.rawMetadataJSON = withChangeSetMetadata(
      appendedItem.rawMetadataJSON, appendedItem.changeSet
    );
    session.items.push(appendedItem);
    session.nextItemSeq += 1;
    if (session.items.length > maxItems()) {
      session.items = session.items.slice(-maxItems());
    }
    emitProviderEvent(session, {
      type: claudeItemProviderEventType(appendedItem),
      turnId: appendedItem.turnId,
      itemId: appendedItem.id,
      item: appendedItem,
      occurredAt: appendedItem.createdAt
    });
    return appendedItem;
  }

  function appendPlanToolFallback(session, call, reason) {
    const id = `${session.id}:plan-tool:${call.sourceCallId}`;
    if (session.items.some((item) => item.id === id)) return;
    appendItem(session, {
      id,
      turnId: call.turnId,
      type: "mcpToolCall",
      title: call.name,
      text: reason === "failed" ? "Plan tool failed"
        : reason === "completed" ? "Task updated without a checklist change" : "Plan tool result unavailable",
      status: reason === "failed" ? "failed" : reason === "completed" ? "completed" : "unknown",
      toolUseId: call.sourceCallId
    });
  }

  function upsertTaskProgressItem(session, message, taskId, terminal) {
    const id = `${session.id}:background-task:${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;
    const index = session.items.findIndex((item) => item.id === id);
    const previous = index >= 0 ? session.items[index] : null;
    const text = taskMessageText(message).slice(0, 2_000) || previous?.text || "Background task";
    const nativeStatus = message?.patch?.status ?? message?.status;
    const status = terminal
      ? (["failed"].includes(nativeStatus) ? "failed"
        : ["killed", "stopped"].includes(nativeStatus) ? "cancelled" : "completed")
      : "running";
    // A late progress packet cannot reopen a task already settled by the SDK.
    if (previous && ["completed", "failed", "cancelled"].includes(previous.status) && !terminal) return;
    const title = previous?.title ?? String(message?.label || message?.subagent_type || "Claude task").slice(0, 160);
    if (previous?.text === text && previous?.status === status) return;
    let originalInput = message?.description ?? null;
    try { originalInput = JSON.parse(previous?.rawMetadataJSON)?.toolExecution?.input ?? originalInput; }
    catch { /* The first update can have no previous structured metadata. */ }
    const rawMetadataJSON = withToolExecutionMetadata(
      previous?.rawMetadataJSON ?? providerRawMetadataJSON("claude-sdk", { taskId }, { source: "normalized_item" }),
      toolExecutionForItem({ id, type: "mcpToolCall", title, status }, {
        input: originalInput,
        result: terminal ? message?.summary ?? message?.patch?.error ?? text : null
      })
    );
    if (!previous) {
      appendItem(session, { id, type: "mcpToolCall", title, text, status, rawMetadataJSON });
      return;
    }
    const updated = { ...previous, text, status, rawMetadataJSON };
    session.items[index] = updated;
    emitProviderEvent(session, {
      type: terminal ? (status === "completed" ? "tool.completed" : "tool.failed") : "tool.progress",
      providerEventId: message?.uuid ? `claude-task:${message.uuid}` : null,
      turnId: updated.turnId,
      itemId: updated.id,
      item: updated,
      occurredAt: session.updatedAt
    });
  }

  function settleToolResults(session, message) {
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const itemId = session.pendingToolCalls?.get(block.tool_use_id);
      if (!itemId) continue;
      session.pendingToolCalls.delete(block.tool_use_id);
      const index = session.items.findIndex((item) => item.id === itemId);
      if (index < 0) continue;
      const previous = session.items[index];
      const preview = claudeToolResultPreview(block.content);
      const updated = {
        ...previous,
        status: block.is_error === true ? "failed" : "completed",
        text: [previous.text, preview].filter(Boolean).join("\n\n"),
        rawMetadataJSON: providerRawMetadataJSON("claude-sdk", {
          toolUseId: block.tool_use_id,
          inputPreview: previous.text,
          resultPreview: preview,
          isError: block.is_error === true
        }, { source: "tool_result" })
      };
      updated.rawMetadataJSON = withToolExecutionMetadata(
        updated.rawMetadataJSON,
        toolExecutionForItem(updated, { input: previous.text, result: preview })
      );
      const sourcePath = previous.changeSet?.changes?.[0]?.path;
      updated.changeSet = sourcePath && block.is_error !== true
        ? changeSetForClaudeTool(previous.title, { file_path: sourcePath },
          claudeStructuredToolResult(message, block, blocks.length))
        : null;
      updated.rawMetadataJSON = withChangeSetMetadata(updated.rawMetadataJSON, updated.changeSet);
      session.items[index] = updated;
      emitProviderEvent(session, {
        type: block.is_error === true ? "tool.failed" : "tool.completed",
        providerEventId: `claude-tool:${message.uuid ?? block.tool_use_id}:${block.tool_use_id}`,
        turnId: updated.turnId,
        itemId: updated.id,
        item: updated,
        occurredAt: message.timestamp ?? session.updatedAt
      });
    }
  }
  return { appendItem, appendPlanToolFallback, upsertTaskProgressItem, settleToolResults };
}

function claudeItemProviderEventType(item) {
  if (item?.neutralNotice) return "execution.notice";
  if (item?.type === "userInput") return "interaction.requested";
  if (item?.type === "agentMessage" || item?.type === "reasoning") {
    return "assistant.message.delta";
  }
  if (item?.type === "choice") return "approval.requested";
  if (item?.status === "failed") return "tool.failed";
  if (item?.status === "completed") return "tool.completed";
  return "tool.started";
}
