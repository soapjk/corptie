// 记忆提炼骨架（13）：从 Session 事件流提取记忆候选，按 kind 分类并分流归属。
//
// - 提取即乐观应用（auto_applied）：落库 promotion_status='active'，不等待用户确认。
// - kind → owner 分流（13 归属规则）：能力类（skill/procedure/dev_experience）→ Agent 进化记忆；
//   其余（fact/lesson/preference/feedback/episodic）→ 工作记忆（work_item > objective 兜底）。
// - classify 可注入 LLM 实现，默认用规则版 defaultClassify。

const ABILITY_KINDS = new Set(["skill", "procedure", "dev_experience"]);

export function ownerForKind(kind, { objectiveId, workItemId, agentId }) {
  // 能力类记忆必须归属到某个 Agent（owner_id NOT NULL）；缺失 agentId 时无法归属，返回 null 由调用方跳过。
  if (ABILITY_KINDS.has(kind)) {
    return agentId ? { ownerType: "agent", ownerId: agentId } : null;
  }
  if (workItemId) return { ownerType: "work_item", ownerId: workItemId };
  if (objectiveId) return { ownerType: "objective", ownerId: objectiveId };
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

  // 从 Session 事件流提取候选并乐观应用；返回落库的记忆数组。
  async extractFromSession(sessionId, scope = {}) {
    const events = this.store.listSessionEvents(sessionId);
    const classified = await this.classifyEvents(events);
    const memories = [];
    for (let i = 0; i < events.length; i++) {
      const result = classified[i];
      if (!result) continue;
      const owner = ownerForKind(result.kind, scope);
      if (!owner) continue; // 无有效归属（如能力类记忆缺失 agentId）时跳过，避免写入 owner_id=null
      memories.push(
        this.store.createMemory({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          kind: result.kind,
          content: result.content,
          sourceType: "extracted",
          sourceSessionId: sessionId,
          sourceEventSeqs: [events[i].sequence],
          baseConfidence: result.baseConfidence ?? 0.5,
          promotionStatus: "active",
          autoApplied: true
        })
      );
    }
    return memories;
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
