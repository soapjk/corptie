// 统一检索 hub（12）：记忆检索 + 工具/技能发现 + 去抖缓存 + none 三岔路。
//
// - retrieveMemory：按 owner 作用域（work_item > objective > agent）收集记忆，关键词匹配 + confidence 排序。
//   （骨架；真实实现用 embedding 语义召回，见 12.7 待定规格。）
// - search：发现工具/技能，先查去抖缓存（命中/否定结果都缓存），未命中则 discover 并缓存。
// - discover 命中否定的 none 三岔路（创建技能 / 自干 / 用户门禁）由调用方裁决，本服务返回 decision 标记。

function defaultHashIntent(text) {
  let hash = 0;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^\w\u4e00-\u9fff]+/)
    .filter(Boolean);
}

function matchScore(content, terms) {
  if (!terms.length) return 0;
  const lower = String(content ?? "").toLowerCase();
  const hit = terms.filter((t) => lower.includes(t)).length;
  return hit / terms.length;
}

export class HubService {
  constructor({ store, hashIntent = defaultHashIntent }) {
    this.store = store;
    this.hashIntent = hashIntent;
  }

  // 记忆检索：按作用域聚合 + 关键词匹配 + confidence 排序
  retrieveMemory(intent, scope = {}) {
    const { objectiveId, workItemId, agentId } = scope;
    const memories = [];
    if (workItemId) memories.push(...this.store.listMemoriesByOwner("work_item", workItemId));
    if (objectiveId) memories.push(...this.store.listMemoriesByOwner("objective", objectiveId));
    if (agentId) memories.push(...this.store.listMemoriesByOwner("agent", agentId));

    const terms = tokenize(intent);
    return memories
      .filter((m) => m.promotion_status === "active")
      .map((m) => ({ memory: m, score: matchScore(m.content, terms) * Number(m.confidence) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.memory);
  }

  // 工具/技能发现 + 去抖缓存
  search(intent, scope = {}, _options = {}) {
    const { objectiveId, workItemId, sessionId, agentId } = scope;
    const intentHash = this.hashIntent(intent);
    // 缓存 key = intentHash + agentId：discover 结果唯一取决于 agentId（其 procedure/skill 记忆），
    // 不同 agent 即使同一 workItem/objective 也不能共享缓存。
    const cached = this.store.getHubIntentCache(intentHash, { agentId });
    if (cached) {
      return { ...JSON.parse(cached.result_json || "{}"), cached: true };
    }
    const result = this.discover(intent, scope);
    this.store.cacheHubIntent({ sessionId, workItemId, objectiveId, agentId, intentHash, result });
    return { ...result, cached: false };
  }

  // 发现：从 Agent 进化记忆里的 procedure/skill 类提取候选（骨架）
  discover(intent, scope = {}) {
    const candidates = [];
    if (scope.agentId) {
      for (const m of this.store.listMemoriesByOwner("agent", scope.agentId)) {
        if (m.kind === "procedure" || m.kind === "skill") {
          candidates.push({ toolName: m.id, description: m.content, kind: m.kind });
        }
      }
    }
    if (candidates.length === 0) {
      return { found: false, candidates: [], decision: "none" };
    }
    return { found: true, candidates, decision: "found" };
  }

  // 注册活跃工具（命中后缓存在 Session 活跃工具集，用后不重查）
  registerActiveTool(sessionId, toolName, toolDef = {}) {
    return this.store.registerActiveTool(sessionId, toolName, toolDef);
  }

  listActiveTools(sessionId) {
    return this.store.listActiveTools(sessionId);
  }
}
