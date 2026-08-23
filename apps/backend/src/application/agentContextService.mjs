// Agent 上下文组装（provider-neutral）：把「Agent 身份 + systemPrompt + description + per-agent 记忆」
// 组装成一段可注入 Provider 会话 / 后台生成的标准上下文。
//
// 设计边界：
// - 不依赖任何具体 Provider 适配器（不 import codex/claude 具体实现），只消费 store + hubService。
// - 交互式会话启动与后台生成共用本入口，保证「指定 Agent 即自动加载其记忆」的语义一致。
// - per-agent 记忆来自三层记忆的 owner_type='agent' 作用域，经 HubService.retrieveMemory 语义召回。

export class AgentContextService {
  constructor({ store, hubService, recallService = null, resolveAgentSkills = null }) {
    if (!store) throw new TypeError("AgentContextService requires a store.");
    if (!hubService) throw new TypeError("AgentContextService requires a hubService.");
    this.store = store;
    this.hubService = hubService;
    this.recallService = recallService;
    // provider-neutral：由组合根注入，返回该 Agent 启用的 Skill 列表
    // [{ name, description, content }]，content 为 SKILL.md 正文摘要。
    // 为空/未注入则跳过 Skill 注入（保持旧行为）。
    this.resolveAgentSkills = resolveAgentSkills;
  }

  // 组装指定 Agent 的完整上下文。intent 用于记忆语义召回（可为空，此时取全部 active 记忆）。
  // 返回 { agent, systemPrompt, description, memories, skills, instructions }。
  async buildAgentContext(agentId, { intent = "", scope = {} } = {}) {
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;

    const recallScope = { ...scope, agentId };
    const recall = this.recallService
      ? await this.recallService.startup(recallScope)
      : null;
    const memories = recall?.memories
      ?? await this.hubService.retrieveMemory(intent, recallScope, { limit: 8, allowEmbedding: false });

    let skills = [];
    if (typeof this.resolveAgentSkills === "function") {
      try {
        skills = await this.resolveAgentSkills(agentId) ?? [];
      } catch {
        skills = [];
      }
    }

    const systemPrompt = String(agent.systemPrompt ?? "").trim();
    const description = String(agent.description ?? "").trim();

    const instructions = this.#renderInstructions({ agent, systemPrompt, description, memories, skills });

    return { agent, systemPrompt, description, memories, skills, instructions, recall };
  }

  // 生成可追加到 Provider 指令的纯文本（不覆盖原协作协议指令，作为补充注入）。
  #renderInstructions({ agent, systemPrompt, description, memories, skills }) {
    const parts = [];

    if (description) {
      parts.push(`You are "${agent.name}" (agent id ${agent.agentId}). Your role: ${description}.`);
    } else {
      parts.push(`You are "${agent.name}" (agent id ${agent.agentId}).`);
    }

    if (systemPrompt) {
      parts.push(`Adopt the following persona and operating rules:\n${systemPrompt}`);
    }

    if (Array.isArray(skills) && skills.length > 0) {
      const skillLines = skills.map((skill) => {
        const desc = skill.description ? ` — ${skill.description}` : "";
        return `- ${skill.name} (id: ${skill.skillId})${desc}`;
      });
      parts.push(
        `The following Skills are assigned to this Agent and available through lazy loading:\n${skillLines.join("\n")}\n` +
        "When a Skill may be relevant, call corptie_skill_search with the current intent, then call corptie_skill_load with the returned skill id before following its instructions. " +
        "The list above is only a compact index; do not assume the full instructions or unlisted Skills are available."
      );
    }

    if (memories.length > 0) {
      const memoryLines = memories.map((m) => {
        const kind = m.kind ? `[${m.kind}] ` : "";
        return `- ${kind}${m.content}`;
      });
      parts.push(`Relevant memories for this Agent (apply them as your established knowledge and preferences):\n${memoryLines.join("\n")}`);
    }

    return parts.join("\n\n");
  }
}
