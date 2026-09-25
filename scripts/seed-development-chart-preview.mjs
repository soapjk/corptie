#!/usr/bin/env node
// Adds an unmistakably synthetic, read-only chart conversation to an existing
// development preview snapshot. Never accepts the production Data Root.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CorptieStore } from "../apps/backend/src/store/corptieStore.mjs";

const requestedRoot = process.argv[2];
if (process.env.CORPTIE_ENV !== "development" || !requestedRoot || !isAbsolute(requestedRoot)) {
  throw new Error("Usage: CORPTIE_ENV=development node scripts/seed-development-chart-preview.mjs /absolute/preview-root");
}
const dataRoot = realpathSync(requestedRoot);
const markerPath = join(dataRoot, ".preview-only");
const dbPath = join(dataRoot, "development", "database", "corptie.sqlite");
if (!existsSync(markerPath) || !existsSync(dbPath)
    || !readFileSync(markerPath, "utf8").startsWith("Development-only browsing snapshot.")) {
  throw new Error("Refusing to write: this is not an existing development-only browsing snapshot.");
}

const sessionId = "session:development-chart-preview-v1";
const turnId = "turn:development-chart-preview-v1";
const fencedChart = (spec) => ["```corptie-chart", JSON.stringify(spec), "```"].join("\n");
const validText = [
  "# 本地合成图表预览",
  "这不是模型回复，也不是正式数据；用于检查同一消息卡片中的 Markdown、图表和后续文字。",
  "## 柱状图",
  fencedChart({ version: 1, type: "bar", title: "三个方案的完成项", unit: "项",
    sourceNote: "本地合成数据", data: [
      { label: "方案甲", value: 31 }, { label: "方案乙", value: 45 }, { label: "方案丙", value: 24 }
    ] }),
  "柱状图下方仍应是同一条消息的普通文字。",
  "## 折线图",
  fencedChart({ version: 1, type: "line", title: "三日进度", unit: "项", data: [
    { x: "2026-09-23", value: 10 }, { x: "2026-09-24", value: 18 }, { x: "2026-09-25", value: 27 }
  ] }),
  "## 饼图",
  fencedChart({ version: 1, type: "pie", title: "工作分布", data: [
    { label: "开发", value: 50 }, { label: "验证", value: 30 }, { label: "设计", value: 20 }
  ] }),
  "末尾文字用于检查消息高度、复制原文和滚动定位。"
].join("\n\n");
const invalidText = [
  "下面的类型故意无效：客户端应保留原始 fenced JSON，而不是丢掉这条消息。",
  fencedChart({ version: 1, type: "donut", title: "无效类型", data: [{ label: "甲", value: 1 }] })
].join("\n\n");
const denseText = [
  "下面是 12 个类别的本地合成数据。图表应保持消息卡片高度不变，并允许在图内纵向滚动；“查看数据”应包含全部 12 项。",
  fencedChart({ version: 1, type: "bar", title: "多类别滚动预览", unit: "项",
    sourceNote: "本地合成数据", data: Array.from({ length: 12 }, (_, index) => ({
      label: `类别 ${index + 1}`, value: (index + 1) * 3
    })) }),
  "这段文字应继续留在同一张消息卡片内。"
].join("\n\n");

const items = [
  { id: "message:development-chart-prompt-v1", type: "userMessage", title: "You",
    text: "查看本地合成图表展示样例", presentationRole: null },
  { id: "message:development-chart-valid-v1", type: "agentMessage", title: "本地合成样例",
    text: validText, presentationRole: "final_answer" },
  { id: "message:development-chart-invalid-v1", type: "agentMessage", title: "本地合成样例",
    text: invalidText, presentationRole: "final_answer" },
  { id: "message:development-chart-dense-v1", type: "agentMessage", title: "本地合成样例",
    text: denseText, presentationRole: "final_answer" }
];

// A second, completed Turn makes the structured execution card inspectable in
// the same read-only preview, without impersonating a real Provider run.
const processSessionId = "session:development-structured-preview-v1";
const processTurnId = "turn:development-structured-preview-v1";
const processItems = [
  { id: "message:development-process-prompt-v1", type: "userMessage", title: "You",
    text: "查看本地合成执行过程展示样例" },
  { id: "plan:development-process-v1", type: "executionPlan", title: "Execution plan",
    text: "Plan 2/3", rawMetadataJSON: JSON.stringify({ executionPlan: {
      schemaVersion: 1, planId: "plan:development-process-v1", revision: 3,
      lifecycle: "completed", updatedAt: "2026-09-25T00:00:00Z",
      explanation: "本地合成数据，用于检查逐项计划与进度条。",
      steps: [
        { stepId: "step:1", ordinal: 0, text: "检查输入", status: "completed" },
        { stepId: "step:2", ordinal: 1, text: "构建视图", status: "completed" },
        { stepId: "step:3", ordinal: 2, text: "等待确认", status: "pending" }
      ]
    } }) },
  { id: "item:development-process-tool-v1", type: "commandExecution", title: "Build",
    text: "Build completed", rawMetadataJSON: JSON.stringify({ toolExecution: {
      schemaVersion: 1, toolId: "tool:development-process-v1", name: "Build",
      status: "completed", input: "swift build", result: "Build complete"
    } }) },
  { id: "item:development-process-failed-tool-v1", type: "mcpToolCall", title: "Preview lookup",
    text: "Synthetic lookup failed", status: "failed",
    rawMetadataJSON: JSON.stringify({ toolExecution: {
      schemaVersion: 1, toolId: "tool:development-failed-v1", name: "Preview lookup",
      status: "failed", input: "lookup preview", result: "No matching preview record"
    } }) },
  { id: "item:development-process-file-v1", type: "fileChange", title: "Changed files",
    text: "Two synthetic files changed", rawMetadataJSON: JSON.stringify({ changeSet: {
      schemaVersion: 1, truncated: false, changes: [
        { path: "Sources/PreviewView.swift", kind: "add", diffPreview: "+ preview", diffTruncated: false },
        { path: "Tests/PreviewTests.swift", kind: "modify", diffPreview: "+ verification", diffTruncated: false }
      ]
    } }) },
  { id: "item:development-process-approval-v1", type: "approval", title: "已处理的合成确认",
    text: "这是一条只读历史确认，用于检查交互卡片状态。", status: "selected",
    options: [{ id: "confirm", label: "确认", selected: true },
      { id: "cancel", label: "取消", selected: false }] },
  { id: "message:development-process-final-v1", type: "agentMessage", title: "本地合成样例",
    text: "这是本地合成的最终回复。上方应有一张可展开的执行过程卡片，包含计划、完成及失败的工具、文件变更；另有一张已处理的只读确认卡片。",
    presentationRole: "final_answer" }
];

const store = new CorptieStore({ dataRoot, dbPath, manageProcessEnvironment: false });
try {
  await store.initialize({ performMigrations: false });
  const missing = items.filter((item) => !store.getSessionItem(sessionId, item.id));
  store.runInTransaction(() => {
    if (!store.getSession(sessionId)) {
      store.createSession({ id: sessionId, title: "图表展示预览", sessionKind: "assistantChat",
        agentName: "本地预览", provider: "codex-app-server", status: "completed" });
    }
    missing.forEach((item) => {
      const index = items.indexOf(item);
      const createdAt = new Date(Date.now() + index * 1_000).toISOString();
      const projected = { ...item, turnId, turnStatus: "completed", status: "completed", createdAt };
      store.appendSessionEvent({ eventId: `event:development-chart-preview-v1:${index}`,
        sessionId, type: item.type === "userMessage" ? "user/message" : "assistant.message.completed",
        source: { type: "development-preview-fixture" }, payload: { item: projected }, createdAt });
      store.upsertTimelineItemProjection(sessionId, projected);
    });
    if (!store.getSession(processSessionId)) {
      store.createSession({ id: processSessionId, title: "结构化消息展示预览", sessionKind: "assistantChat",
        agentName: "本地预览", provider: "codex-app-server", status: "completed" });
    }
    processItems.filter((item) => !store.getSessionItem(processSessionId, item.id)).forEach((item) => {
      const index = processItems.indexOf(item);
      const createdAt = new Date(Date.now() + (items.length + index) * 1_000).toISOString();
      const projected = { ...item, turnId: processTurnId, turnStatus: "completed",
        status: item.status ?? "completed", createdAt };
      store.appendSessionEvent({ eventId: `event:development-structured-preview-v1:${index}`,
        sessionId: processSessionId,
        type: item.type === "userMessage" ? "user/message"
          : item.type === "agentMessage" ? "assistant.message.completed" : "timeline.item.updated",
        source: { type: "development-preview-fixture" }, payload: { item: projected }, createdAt });
      store.upsertTimelineItemProjection(processSessionId, projected);
    });
  });
  console.log(`Synthetic preview sessions ${sessionId} and ${processSessionId}: chart items added ${missing.length}`);
} finally {
  await store.close();
}
