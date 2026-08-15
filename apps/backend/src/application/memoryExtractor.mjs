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

export class MemoryExtractor {
  constructor({ store, classify = defaultClassify }) {
    this.store = store;
    this.classify = classify;
  }

  // 从 Session 事件流提取候选并乐观应用；返回落库的记忆数组。
  extractFromSession(sessionId, scope = {}) {
    const events = this.store.listSessionEvents(sessionId);
    const memories = [];
    for (const event of events) {
      const classified = this.classify(event);
      if (!classified) continue;
      const owner = ownerForKind(classified.kind, scope);
      if (!owner) continue; // 无有效归属（如能力类记忆缺失 agentId）时跳过，避免写入 owner_id=null
      memories.push(
        this.store.createMemory({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          kind: classified.kind,
          content: classified.content,
          sourceType: "extracted",
          sourceSessionId: sessionId,
          sourceEventSeqs: [event.sequence],
          promotionStatus: "active"
        })
      );
    }
    return memories;
  }
}
