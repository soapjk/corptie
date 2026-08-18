// 统一检索 hub（12）：记忆检索 + 工具/技能发现 + 去抖缓存 + none 三岔路。
//
// - retrieveMemory：按 owner 作用域（work_item > objective > agent）收集记忆，
//   优先 embedding 语义召回（embedder 注入），回退关键词匹配；confidence 加权排序。
// - search：发现工具/技能，先查去抖缓存（命中/否定结果都缓存），未命中则 discover 并缓存。
// - discover 命中否定的 none 三岔路（proposeSkill 起草技能 / justDoIt 自干 / 用户门禁）由调用方裁决。
// - proposeSkill：创建技能 = 持久副作用，走 guard 分级（至少 moderate），默认落 draft 待用户裁决。

import { randomUUID } from "node:crypto";

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

// 字符 n-gram 词袋向量（零依赖离线回退，非真语义，但保证 embedding 路径可用、可离线排序）。
export function localBagOfWordsEmbedder(text, dim = 128) {
  const grams = new Set();
  const raw = String(text ?? "").toLowerCase();
  for (let n = 2; n <= 3; n += 1) {
    for (let i = 0; i + n <= raw.length; i += 1) {
      grams.add(raw.slice(i, i + n));
    }
  }
  const vec = new Array(dim).fill(0);
  for (const g of grams) {
    let h = 0;
    for (let i = 0; i < g.length; i += 1) h = (h * 31 + g.charCodeAt(i)) | 0;
    vec[Math.abs(h) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// OpenAI 兼容 embedding 注入（12.7 语义召回）；无 API key 时返回 null，调用方回退本地词袋。
export function createOpenAiEmbedder(choiceParser = {}) {
  const apiKey = choiceParser.openaiApiKey || process.env.OPENAI_API_KEY || process.env.CORPTIE_OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = choiceParser.embeddingModel || "text-embedding-3-small";
  const raw = typeof choiceParser.openaiBaseURL === "string" && choiceParser.openaiBaseURL.trim()
    ? choiceParser.openaiBaseURL.trim()
    : "https://api.openai.com/v1";
  const base = raw.replace(/\/+$/, "");
  const endpoint = /\/embeddings$/i.test(base) ? base : `${base}/embeddings`;

  return async (text) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: String(text ?? "") })
    });
    if (!response.ok) throw new Error(`embedding failed: HTTP ${response.status}`);
    const data = await response.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return null;
    return vec;
  };
}

export class HubService {
  // embedder：embed(text) → number[]（可注入 OpenAI 或本地 ONNX）；缺失时回退 localBagOfWordsEmbedder。
  constructor({ store, hashIntent = defaultHashIntent, embedder = null }) {
    this.store = store;
    this.hashIntent = hashIntent;
    this.embedder = embedder;
    this.fallbackEmbedder = localBagOfWordsEmbedder;
  }

  // 记忆检索（12）：作用域聚合 → embedding 召回（回退关键词）→ confidence 加权排序。
  async retrieveMemory(intent, scope = {}, options = {}) {
    const { objectiveId, workItemId, agentId } = scope;
    const memories = [];
    if (workItemId) memories.push(...this.store.listMemoriesByOwner("work_item", workItemId));
    if (objectiveId) memories.push(...this.store.listMemoriesByOwner("objective", objectiveId));
    if (agentId) memories.push(...this.store.listMemoriesByOwner("agent", agentId));

    const active = memories.filter((m) => m.promotion_status === "active" && !m.revoked_at);
    const normalizedIntent = String(intent ?? "").trim();
    const scored = await this.scoreMemories(normalizedIntent, active);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const selected = scored
      .filter((x) => normalizedIntent === "" || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.memory);
    if (options.touch !== false) {
      for (const memory of selected) this.store.touchMemory(memory.id);
      return selected.map((memory) => this.store.getMemory(memory.id) ?? memory);
    }
    return selected;
  }

  // 语义 + 关键词混合打分：有 embedder 则用余弦相似度，否则回退关键词；confidence 加权。
  async scoreMemories(intent, memories) {
    const terms = tokenize(intent);
    let intentVec = null;
    if (this.embedder) {
      try {
        intentVec = await this.embedder(intent);
      } catch {
        intentVec = null;
      }
    }
    if (!intentVec) {
      intentVec = null;
    }

    const results = [];
    for (const m of memories) {
      let semantic = 0;
      if (intentVec) {
        let memVec = this.store.getMemoryEmbedding(m.id);
        if (!memVec) {
          try {
            memVec = await this.embedder(m.content);
            this.store.setMemoryEmbedding(m.id, memVec);
          } catch {
            memVec = null;
          }
        }
        semantic = memVec ? cosineSimilarity(intentVec, memVec) : 0;
      }
      const lexical = matchScore(m.content, terms);
      // 语义优先；无语义时纯关键词；两者取高者再乘置信度。
      // 空 intent 是显式的启动召回策略：按置信度与既有使用/新近度排序，
      // 而不是让零关键词分数把所有 active 记忆过滤掉。
      const emptyIntentScore = terms.length === 0
        ? 1 + Math.min(Number(m.usage_count ?? 0), 10) * 0.01 + Math.min(Number(m.recency_score ?? 0), 10) * 0.001
        : 0;
      const raw = Math.max(semantic, lexical, emptyIntentScore);
      results.push({ memory: m, score: raw * Number(m.confidence ?? 0.5) });
    }
    return results;
  }

  // 工具/技能发现 + 去抖缓存
  search(intent, scope = {}, _options = {}) {
    const { objectiveId, workItemId, sessionId, agentId } = scope;
    const intentHash = this.hashIntent(intent);
    const cached = this.store.getHubIntentCache(intentHash, { agentId });
    if (cached) {
      return { ...JSON.parse(cached.result_json || "{}"), cached: true };
    }
    const result = this.discover(intent, scope);
    this.store.cacheHubIntent({ sessionId, workItemId, objectiveId, agentId, intentHash, result });
    return { ...result, cached: false };
  }

  // 发现（12.5）：从 Agent 进化记忆里的 procedure/skill 类 + 已发布 skills 表提取候选。
  discover(intent, scope = {}) {
    const candidates = [];
    if (scope.agentId) {
      for (const m of this.store.listMemoriesByOwner("agent", scope.agentId)) {
        if (!m.revoked_at && m.promotion_status === "active" && (m.kind === "procedure" || m.kind === "skill")) {
          candidates.push({ toolName: m.id, description: m.content, kind: m.kind });
        }
      }
      // Agent Skill Registry 是会话可用 Skill 的授权边界。这里只暴露轻量索引，
      // 完整 SKILL.md 必须通过受 actorId 校验的 corptie_skill_load 按需读取。
      for (const skill of this.store.listRegistrySkillsForAgent(scope.agentId)) {
        candidates.push({
          skillId: skill.skillId,
          toolName: skill.manifestName || skill.name,
          description: skill.manifestDescription || skill.description || skill.name,
          kind: "registered_skill",
          contentHash: skill.contentHash || ""
        });
      }
    }
    for (const s of this.store.listDiscoverableSkills()) {
      candidates.push({
        toolName: s.name,
        description: s.scenario || s.name,
        kind: "skill",
        riskLevel: s.risk_level
      });
    }
    if (candidates.length === 0) {
      return { found: false, candidates: [], decision: "none" };
    }
    return { found: true, candidates, decision: "found" };
  }

  // none 三岔路（12.6）：起草新技能草稿。创建技能是持久副作用，默认落 draft 待用户裁决
  // （guard 分级见 01；此处 status='draft' 即「未经批准不落 discoverable」）。
  proposeSkill(draft, { agentId = null, sourceSessionId = null } = {}) {
    if (!draft || !draft.name || !draft.scenario) {
      return { accepted: false, reason: "INVALID_DRAFT" };
    }
    const id = `skill:${randomUUID()}`;
    const skill = this.store.createSkill({
      id,
      name: draft.name,
      scenario: draft.scenario,
      trigger: draft.trigger ?? "",
      steps: draft.steps ?? [],
      riskLevel: draft.riskLevel ?? "moderate",
      sourceAgentId: agentId,
      status: "draft"
    });
    return { accepted: true, skill };
  }

  // 注册活跃工具（命中后缓存在 Session 活跃工具集，用后不重查）
  registerActiveTool(sessionId, toolName, toolDef = {}) {
    return this.store.registerActiveTool(sessionId, toolName, toolDef);
  }

  listActiveTools(sessionId) {
    return this.store.listActiveTools(sessionId);
  }
}
