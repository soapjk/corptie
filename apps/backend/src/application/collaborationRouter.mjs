// 合作调度中心路由（14）：协作目录注册 + 中央路由打分 + 主动触发检测。
//
// 14.6 路由（已决 A：Objective 一级路由）：
//   score = w1·objective_relevance + w2·capability_match + w3·trust
//         + w4·availability_weight - w5·load_penalty
// 14.7 主动触发检测（四类，前三默认开、第四默认关）。
// Delegation/Consultation 执行层复用 collaborationCore 的 collaboration_requests 状态机。

function parseJsonArray(json) {
  try {
    const value = JSON.parse(json ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// 命中率：b 中有多少项被 a 覆盖
function overlapRatio(candidateTags, requested) {
  if (!requested || requested.length === 0) return 0;
  const set = new Set(candidateTags);
  const hit = requested.filter((tag) => set.has(tag)).length;
  return hit / requested.length;
}

// 14.6 五项权重（可调；objective 一级权重最高，已决 A）。
const ROUTE_WEIGHTS = {
  objective: 0.4,
  capability: 0.3,
  trust: 0.15,
  availability: 0.15,
  loadPenalty: 0.1
};

export class AssistantNotRoutableError extends Error {
  constructor(agentId) {
    super(`Assistant agent is not routable: ${agentId}`);
    this.name = "AssistantNotRoutableError";
    this.code = "ASSISTANT_NOT_ROUTABLE";
  }
}

export class CollaborationRouter {
  constructor({ store, weights = ROUTE_WEIGHTS }) {
    this.store = store;
    this.weights = { ...ROUTE_WEIGHTS, ...weights };
  }

  registerAgent({ agentId, role = "independentContributor", capabilityTags = [], description = "", availability = "idle", endpoint = {} }) {
    // 设计 14 铁律：助手 Agent（role=assistant）不入协作目录、永不参与自动路由。
    if (role === "assistant") {
      throw new AssistantNotRoutableError(agentId);
    }
    return this.store.upsertCollaborator({
      entryType: "agent",
      entryId: agentId,
      role,
      capabilityTags,
      description,
      availability,
      trustScore: this.store.getReputation(agentId)?.trust_score ?? 0.5,
      endpoint
    });
  }

  registerObjective({ objectiveId, capabilityTags = [], description = "", policy = {} }) {
    return this.store.upsertCollaborator({
      entryType: "objective",
      entryId: objectiveId,
      capabilityTags,
      description,
      policy
    });
  }

  // 路由：给定协作请求，召回可用 Agent 并按分数降序返回（默认 top-k=3）。
  // request: { objectiveTags?, requiredCapabilities?, excludeAgentId?, topK? }
  route(request = {}) {
    const { objectiveTags = [], requiredCapabilities = [], excludeAgentId, topK = 3 } = request;
    return this.store
      .listCollaborators("agent")
      .filter(
        (agent) =>
          agent.role !== "assistant" &&
          agent.entry_id !== excludeAgentId &&
          agent.availability !== "offline"
      )
      .map((agent) => ({
        candidate: agent,
        score: this.scoreAgent(agent, { objectiveTags, requiredCapabilities }),
        reason: this.buildReason(agent, { objectiveTags, requiredCapabilities })
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // 14.6 五项打分：objective 一级 + capability 二级 + trust + availability - load_penalty
  scoreAgent(agent, { objectiveTags, requiredCapabilities }) {
    const tags = parseJsonArray(agent.capability_tags_json);
    const w = this.weights;

    const objectiveScore = overlapRatio(tags, objectiveTags);
    const capabilityScore = overlapRatio(tags, requiredCapabilities);
    const trust = Number(agent.trust_score ?? 0.5);

    // 空闲>忙碌>离线；离线已在 route 过滤，busy 打 0.5
    const availabilityWeight = agent.availability === "idle" ? 1 : 0.5;

    // 当前在跑协作数，线性惩罚（封顶避免负分失控）
    const load = this.store.countActiveCollaborations(agent.entry_id);
    const loadPenalty = Math.min(load * w.loadPenalty, 0.5);

    return (
      w.objective * objectiveScore +
      w.capability * capabilityScore +
      w.trust * trust +
      w.availability * availabilityWeight -
      loadPenalty
    );
  }

  buildReason(agent, { objectiveTags, requiredCapabilities }) {
    const tags = parseJsonArray(agent.capability_tags_json);
    const objectiveScore = overlapRatio(tags, objectiveTags);
    const capabilityScore = overlapRatio(tags, requiredCapabilities);
    return {
      objective_relevance: objectiveScore,
      capability_match: capabilityScore,
      trust_score: Number(agent.trust_score ?? 0.5),
      availability: agent.availability,
      active_collaborations: this.store.countActiveCollaborations(agent.entry_id)
    };
  }

  // 取最优候选
  routeBest(request = {}) {
    return this.route(request)[0] ?? null;
  }

  // 14.7 主动触发检测：返回应触发协作的候选建议（四类，前三默认开、第四默认关）。
  // triggers: { agentSelfReport, memoryPointer, guardBlock, failureAccumulation }
  detectCollaborationTriggers(input = {}) {
    const {
      capabilityPool = [],
      requiredCapabilities = [],
      memoryHits = [],
      guardBlocked = false,
      consecutiveFailures = 0,
      failureThreshold = 3,
      enableFailureAccumulation = false // 第四类默认关闭
    } = input;

    const triggers = [];

    // 1. Agent 自申报：所需能力不在自身 capability_pool 内（最准，默认开）
    const poolSet = new Set(capabilityPool);
    const missing = (requiredCapabilities ?? []).filter((c) => !poolSet.has(c));
    if (missing.length > 0) {
      triggers.push({ type: "agent_self_report", missingCapabilities: missing });
    }

    // 2. 记忆指针：命中 structured_json.type='collaborator_ref' 的记忆（默认开）
    for (const hit of memoryHits) {
      const structured = hit?.structured_json ?? hit?.structuredJson ?? {};
      const parsed = typeof structured === "string" ? parseJsonArray(structured) : structured;
      if (parsed && parsed.type === "collaborator_ref") {
        triggers.push({ type: "memory_pointer", collaboratorRef: parsed.collaborator_ref ?? parsed.collaboratorRef });
        break;
      }
    }

    // 3. guard 阻断：越出作用域被拦下（默认开）
    if (guardBlocked) {
      triggers.push({ type: "guard_block" });
    }

    // 4. 失败重试累积（默认关闭，防误触发）
    if (enableFailureAccumulation && consecutiveFailures >= failureThreshold) {
      triggers.push({ type: "failure_accumulation", consecutiveFailures });
    }

    return { shouldCollaborate: triggers.length > 0, triggers };
  }
}
