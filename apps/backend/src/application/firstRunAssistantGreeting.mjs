// Product-owned introduction, persisted through the shared timeline used by
// desktop and mobile. No Provider request or synthetic user turn is needed.
export function ensureFirstRunAssistantGreeting(store, sessionId, language = "zh-Hans") {
  const id = `first-run:introduction:v1:${sessionId}`;
  return store.runInTransaction(() => {
    if (store.getSessionItem(sessionId, id)) return;
    const item = {
      id, type: "agentMessage", title: "Corptie", status: "completed",
      turnId: id, turnStatus: "completed", presentationRole: "assistant",
      text: language.toLowerCase().startsWith("zh") ? "你好，我是你的 Corptie 助理。Agent 已配置完成，我们可以开始了。\n\n我可以帮你了解 Corptie、创建 Work，并协助你开展具体任务。\n\n你现在想做什么？也可以先告诉我一个目标，我们一起开始。"
        : "Hi, I’m your Corptie assistant. Your Agent is ready, and we can get started.\n\nI can help you explore Corptie, create a Work, and carry out tasks.\n\nWhat would you like to do? Tell me a goal, and we’ll start together.",
      createdAt: new Date().toISOString(),
      source: "first-run-introduction"
    };
    store.upsertTimelineItemProjection(sessionId, { ...item, rawMetadataJSON: JSON.stringify(item) });
  });
}
