// 记忆提炼骨架（13）：从 Session 事件流提取记忆候选，按 kind 分类并分流归属。
//
// - 提取结果仅作为不可信候选落库；未经可信来源确认不得自动应用或晋升。
// - kind → owner 分流（13 归属规则）：能力类（skill/procedure/dev_experience）→ Agent 进化记忆；
//   其余（fact/lesson/preference/feedback/episodic）→ 工作记忆（task > work 兜底）。
// - classify 可注入 LLM 实现，默认用规则版 defaultClassify。

const ABILITY_KINDS = new Set(["skill", "procedure", "dev_experience"]);

export function ownerForKind(kind, { workId, taskId, agentId }) {
  // 能力类记忆必须归属到某个 Agent（owner_id NOT NULL）；缺失 agentId 时无法归属，返回 null 由调用方跳过。
  if (ABILITY_KINDS.has(kind)) {
    return agentId ? { ownerType: "agent", ownerId: agentId } : null;
  }
  if (taskId) return { ownerType: "task", ownerId: taskId };
  if (workId) return { ownerType: "work", ownerId: workId };
  return agentId ? { ownerType: "agent", ownerId: agentId } : null;
}

function safeParse(json) {
  if (json == null) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// 规则版默认分类：按事件类型映射 kind（骨架；真实实现可注入 LLM 分类器）
// 注意：事件来自 store.listSessionEvents()，其 payload 已是解析后的对象。
export function defaultClassify(event) {
  const type = String(event?.type ?? "");
  const payload = event?.payload ?? safeParse(event?.payload_json);
  const text = String(
    payload?.text ?? payload?.summary ?? payload?.content ?? payload?.message ?? ""
  ).trim();
  if (!text) return null;

  if (type === "SessionUserMessageCreated" || type === "user.message.accepted") {
    return /记住|以后|始终|偏好|约定|不要|remember|always|never|prefer/i.test(text)
      ? { kind: "preference", content: text.slice(0, 1000) } : null;
  }
  if (type === "assistant.message.completed") {
    return /修复|实现|决定|约定|规则|原因|结论|验证|fixed|implemented|decided|rule|lesson|learned|verified/i.test(text)
      ? { kind: "fact", content: text.slice(0, 1000) } : null;
  }

  if (/(error|fail|exception)/i.test(type)) return { kind: "lesson", content: text };
  if (/feedback/i.test(type)) return { kind: "feedback", content: text };
  if (/(summary|complete|result)/i.test(type)) return { kind: "fact", content: text };
  if (/(tool|command|mcp)/i.test(type)) return { kind: "procedure", content: text };
  return null;
}

const MEMORY_CLASSIFY_PROMPT = [
  "You extract durable memories from agent-session event text for a developer platform.",
  "Classify each event into exactly one kind, or null if it carries no durable signal.",
  "Kinds:",
  "  skill — reusable capability the agent learned (a way of doing things)",
  "  procedure — reproducible multi-step workflow / command sequence",
  "  dev_experience — project-specific technical insight (library quirk, build gotcha, convention)",
  "  fact — stable statement about the codebase/product/user",
  "  lesson — something learned from a mistake or failure",
  "  preference — a stated user preference or style rule",
  "  feedback — user feedback on the agent's behavior",
  "  episodic — a notable one-off event with little reuse value",
  "Respond ONLY with JSON: { \"results\": [{ \"kind\": \"skill\"|..., \"content\": \"condensed durable statement\" } | null, ...] }",
  "Preserve array order and length exactly (one entry per input event)."
].join("\n");

function openAiCompatibleChatCompletionsURL(baseURL) {
  const raw = typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : "https://api.openai.com/v1";
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) return withoutTrailingSlash;
  return `${withoutTrailingSlash}/chat/completions`;
}

// 可注入的 LLM 记忆分类器：批量 classify(events) → 与 events 等长的 [{kind, content}|null]。
// 无 LLM 配置时返回 null，调用方回退 defaultClassify。
export function createMemoryClassifier(choiceParser = {}) {
  const apiKey = choiceParser.openaiApiKey || process.env.OPENAI_API_KEY || process.env.CORPTIE_OPENAI_API_KEY;
  if (choiceParser.provider !== "openai" || !apiKey) return null;

  const model = choiceParser.openaiModel || "gpt-4o-mini";
  const endpoint = openAiCompatibleChatCompletionsURL(choiceParser.openaiBaseURL);

  return async (events) => {
    const texts = events.map((event) => {
      const payload = event?.payload ?? safeParse(event?.payload_json);
      return String(payload?.text ?? payload?.summary ?? payload?.content ?? payload?.message ?? "").trim();
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: MEMORY_CLASSIFY_PROMPT },
          { role: "user", content: JSON.stringify(texts) }
        ]
      })
    });
    if (!response.ok) throw new Error(`LLM classify failed: HTTP ${response.status}`);
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const results = JSON.parse(raw)?.results;
    if (!Array.isArray(results)) return null;
    return results.map((r, i) => {
      if (!r || typeof r.kind !== "string") return null;
      const content = String(r.content ?? "").trim();
      if (!content) return null;
      return { kind: r.kind, content };
    });
  };
}

export class MemoryExtractor {
  // classify：单事件分类器（defaultClassify 风格）；classifyMany：批量分类器（createMemoryClassifier 风格，可选）。
  constructor({ store, classify = defaultClassify, classifyMany = null }) {
    this.store = store;
    this.classify = classify;
    this.classifyMany = classifyMany;
  }

  // 从 Session 事件流提取不可信候选；返回落库的记忆数组。
  async extractFromSession(sessionId, claimedScope = {}, { reprocess = false } = {}) {
    const scope = this.resolveExecutionScope(sessionId, claimedScope);
    const memories = [];
    let after = reprocess ? 0 : this.store.getMemoryExtractionProgress(sessionId);
    while (true) {
      const events = this.store.listSessionEvents(sessionId, after, 200);
      if (events.length === 0) break;
      const eligible = events.map((event) => memoryExtractionEvent(this.store, sessionId, event));
      const selected = eligible.filter(Boolean);
      const classified = selected.length ? await this.classifyEvents(selected) : [];
      this.store.runInTransaction(() => {
        for (let i = 0; i < selected.length; i += 1) {
          const event = selected[i];
          const result = classified[i];
          if (!result || !String(result.content ?? "").trim()) continue;
          const owner = ownerForKind(result.kind, scope);
          if (!owner) continue;
          const sourceEventSequence = event.sequence;
          const existing = this.store.getMemoryBySourceEvent({
            ownerType: owner.ownerType, ownerId: owner.ownerId,
            sourceSessionId: sessionId, sourceEventSequence
          });
          if (existing) {
            if (reprocess && existing.promotion_status === "candidate"
              && existing.content !== String(result.content).trim()) {
              memories.push(this.store.updateMemory(existing.id, {
                content: String(result.content).trim().slice(0, 4000),
                confidence: result.baseConfidence ?? existing.confidence,
                version: Number(existing.version ?? 1) + 1
              }));
            }
            continue;
          }
          memories.push(this.store.createMemory({
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            taskId: owner.ownerType === "task" ? scope.taskId : null,
            kind: result.kind,
            content: String(result.content).trim().slice(0, 4000),
            sourceType: "extracted",
            sourceSessionId: sessionId,
            sourceEventSequence,
            sourceEventSeqs: [sourceEventSequence],
            structuredJson: { extraction: { eventId: event.eventId ?? null, eventType: event.type, eventSequence: sourceEventSequence } },
            baseConfidence: result.baseConfidence ?? 0.5,
            promotionStatus: "candidate",
            autoApplied: false,
            trustLevel: "untrusted"
          }));
        }
        after = events.at(-1).sequence;
        this.store.setMemoryExtractionProgress(sessionId, after);
      });
      if (events.length < 200) break;
    }
    return memories;
  }

  resolveExecutionScope(sessionId, claimedScope = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw memoryExtractionError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    if (!["worker", "workChat", "assistantChat"].includes(session.sessionKind)) {
      throw memoryExtractionError(
        "MEMORY_SESSION_KIND_UNSUPPORTED",
        "Memory extraction requires a supported Session kind."
      );
    }
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    if (session.sessionKind === "worker" && (!task || task.work_id !== session.workId)) {
      throw memoryExtractionError(
        "INVALID_TASK_SESSION",
        "The Session is not bound to its Task and Work."
      );
    }
    if (session.workId && !this.store.getWork(session.workId)) {
      throw memoryExtractionError("WORK_NOT_FOUND", "The Session references a missing Work.");
    }
    const derived = {
      workId: session.workId ?? null,
      taskId: session.sessionKind === "worker" ? session.taskId : null,
      agentId: session.agentId ?? task?.main_agent_id ?? null
    };
    for (const key of ["workId", "taskId", "agentId"]) {
      const claimed = typeof claimedScope[key] === "string" ? claimedScope[key].trim() : "";
      if (claimed && claimed !== derived[key]) {
        throw memoryExtractionError(
          "MEMORY_SCOPE_MISMATCH",
          `${key} does not match the bound Worker Session.`
        );
      }
    }
    return derived;
  }

  // 优先走批量 LLM 分类器（classifyMany），失败/缺失回退单事件规则分类。
  async classifyEvents(events) {
    if (this.classifyMany) {
      try {
        const results = await this.classifyMany(events);
        if (Array.isArray(results) && results.length === events.length) return results;
      } catch {
        // LLM 失败 → 回退规则版
      }
    }
    return events.map((event) => this.classify(event));
  }
}

function memoryExtractionEvent(store, sessionId, event) {
  if (event?.type === "memory/inject" || event?.producer === "memory"
    || event?.source?.type === "memory-recall") return null;
  const payload = event?.payload ?? safeParse(event?.payload_json);
  const direct = [payload?.text, payload?.summary, payload?.content, payload?.message]
    .find((value) => typeof value === "string" && value.trim());
  const nested = typeof payload?.message?.text === "string" ? payload.message.text : null;
  const itemId = event?.type === "assistant.message.completed" ? payload?.itemReference?.id : null;
  const item = itemId ? store.getSessionItem(sessionId, itemId) : null;
  const text = String(direct ?? nested ?? item?.text ?? payload?.itemReference?.summary ?? "").trim();
  if (!text) return null;
  return { ...event, payload: { ...payload, text: text.slice(0, 4000) } };
}

function memoryExtractionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
