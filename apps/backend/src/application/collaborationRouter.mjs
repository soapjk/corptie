// 合作调度中心路由（14）：协作目录注册 + 中央路由打分。
//
// 设计 14 的 A 决策：Objective 域为一级路由（域相关性召回），Agent 能力契合为二级精排；
// 叠加声誉（trust_score）与可用性（offline 排除、busy 惩罚）。
// 本骨架聚焦可落地的「目录注册 + 打分排序」，Delegation/Consultation 执行层复用现有
// collaborationCore 的 collaboration_tasks 状态机。

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

export class AssistantNotRoutableError extends Error {
  constructor(agentId) {
    super(`Assistant agent is not routable: ${agentId}`);
    this.name = "AssistantNotRoutableError";
    this.code = "ASSISTANT_NOT_ROUTABLE";
  }
}

export class CollaborationRouter {
  constructor({ store }) {
    this.store = store;
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

  // 路由：给定协作请求，召回可用 Agent 并按分数降序返回。
  // request: { objectiveTags?, requiredCapabilities?, excludeAgentId? }
  route(request = {}) {
    const { objectiveTags = [], requiredCapabilities = [], excludeAgentId } = request;
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
        score: this.scoreAgent(agent, { objectiveTags, requiredCapabilities })
      }))
      .sort((a, b) => b.score - a.score);
  }

  // 打分：能力契合 0.5 + 域相关 0.3 + 声誉 0.2，乘可用性系数
  scoreAgent(agent, { objectiveTags, requiredCapabilities }) {
    const tags = parseJsonArray(agent.capability_tags_json);
    const capabilityScore = overlapRatio(tags, requiredCapabilities);
    const objectiveScore = overlapRatio(tags, objectiveTags);
    const trust = Number(agent.trust_score ?? 0.5);
    const availability = agent.availability === "idle" ? 1 : 0.5;
    return (capabilityScore * 0.5 + objectiveScore * 0.3 + trust * 0.2) * availability;
  }

  // 取最优候选
  routeBest(request = {}) {
    return this.route(request)[0] ?? null;
  }
}
