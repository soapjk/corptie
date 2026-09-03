// 助手对话服务（03 §16.4 / 07 agent.assistant.chat）：自然语言 → 元操作工具调用。
//
// 助手复用 owner_type 管理接口（work.*/task.*/memory.* 等）作为 assistant_tools，
// 把「用户自然语言指令」翻译为这些调用。
//
// 意图识别可注入 LLM（intentResolver，function-calling 风格）：
//   - 有 LLM 配置（choiceParser.provider=openai + apiKey）→ 用 OpenAI 兼容 JSON mode 识别 { tool, args }
//   - 否则 / LLM 失败 → 回退规则版 parseIntent
//
// 每个管理调用仍应走 guard 分级审批（03 §15.3/§16.4.4）；本骨架先实现 safe/moderate 的
// 可逆操作（建目标/建工作项）直接执行，dangerous（删除/批量改）留待 guard 审批系统接上。

function extractQuoted(text) {
  const match = String(text ?? "").match(/[「"“']([^」"”']+)[」"”']/);
  return match ? match[1] : null;
}

const ASSISTANT_TOOLS_PROMPT = [
  "You are Corptie's assistant. The user gives a natural-language instruction about managing the Corptie platform.",
  "Decide which tool to call and return ONLY JSON.",
  "Tools:",
  'work.create: { "name": string } — create an work/goal',
  'task.create: { "title": string, "workId": string? } — create a work item/task',
  'agent.create: { "name": string, "provider": string? } — create an agent',
  'agent.list: {} — list agents',
  'agent.delete: { "name": string } — delete an agent by name',
  'memory.list: {} — list memories',
  'unknown: {} — none of the above',
  'Return format: { "tool": "work.create", "args": { "name": "..." } }',
  'If unclear or unrelated, return { "tool": "unknown", "args": {} }.'
].join("\n");

export function createAssistantIntentResolver(choiceParser = {}) {
  const apiKey = choiceParser.openaiApiKey || process.env.OPENAI_API_KEY || process.env.CORPTIE_OPENAI_API_KEY;
  if (choiceParser.provider !== "openai" || !apiKey) return null;

  const model = choiceParser.openaiModel || "gpt-4o-mini";
  const endpoint = openAiCompatibleChatCompletionsURL(choiceParser.openaiBaseURL);

  return async (content) => {
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
          { role: "system", content: ASSISTANT_TOOLS_PROMPT },
          { role: "user", content }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`LLM intent failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { tool: parsed.tool, args: parsed.args ?? {} };
  };
}

function openAiCompatibleChatCompletionsURL(baseURL) {
  const raw = typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : "https://api.openai.com/v1";
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) return withoutTrailingSlash;
  return `${withoutTrailingSlash}/chat/completions`;
}

export class AssistantService {
  constructor({ store, workService, intentResolver = null, onEntityChanged = null }) {
    this.store = store;
    this.workService = workService;
    this.intentResolver = intentResolver;
    this.onEntityChanged = onEntityChanged;
  }

  // 对话主入口：{ content, sessionId? } → { sessionId, messages }
  async chat(content, sessionId = null) {
    const intent = await this.resolveIntent(content);
    const messages = this.execute(intent, content);
    return { sessionId: sessionId ?? "assistant-chat", messages };
  }

  async resolveIntent(content) {
    if (this.intentResolver) {
      try {
        const intent = await this.intentResolver(content);
        if (intent && intent.tool) return intent;
      } catch {
        // LLM 失败 → 回退规则版
      }
    }
    return this.parseIntent(content);
  }

  // 规则版意图识别（骨架；LLM 版经 intentResolver 注入）
  parseIntent(content) {
    const text = String(content ?? "").trim();
    if (!text) return { tool: "none", args: {} };

    if (/建|创建|新建/.test(text) && /目标|work/i.test(text)) {
      return { tool: "work.create", args: { name: this.extractName(text) } };
    }
    if (/建|创建|新建/.test(text) && /工作项|任务|task|work.?item/i.test(text)) {
      return { tool: "task.create", args: { title: this.extractName(text) } };
    }
    if (/建|创建|新建/.test(text) && /agent|智能体|助手/i.test(text)) {
      return { tool: "agent.create", args: { name: this.extractName(text) } };
    }
    if (/删除|移除/.test(text) && /agent|智能体/i.test(text)) {
      return { tool: "agent.delete", args: { name: this.extractName(text) } };
    }
    if (/(有哪些|列出|列表)/.test(text) && /agent|智能体/i.test(text)) {
      return { tool: "agent.list", args: {} };
    }
    if (/记忆|回忆|查.*记/.test(text)) {
      return { tool: "memory.list", args: {} };
    }
    return { tool: "unknown", args: {} };
  }

  extractName(text) {
    const quoted = extractQuoted(text);
    if (quoted) return quoted;
    const cleaned = String(text ?? "")
      .replace(/^(请|帮我|麻烦|麻烦帮我|请帮我)?\s*/, "")
      .replace(/^(建|创建|新建|删除|移除)\s*(一个|个|一下)?\s*(目标|工作项|任务|work|task|agent|智能体|助手)?\s*/i, "")
      .replace(/[。.!！？?]+$/, "")
      .trim();
    return cleaned || "未命名";
  }

  execute(intent, content) {
    const args = intent.args ?? {};
    switch (intent.tool) {
      case "work.create": {
        return [
          { role: "user", content },
          {
            role: "assistant",
            content: "创建 Work 必须先选择至少一个 Contributor Agent。请使用“新建 Work”表单完成创建。"
          }
        ];
      }
      case "task.create": {
        const works = this.workService.listWorks();
        const specified = args.workId
          ? works.find((o) => o.id === args.workId)
          : null;
        let work = specified ?? works[0];
        if (!work) {
          return [
            { role: "user", content },
            { role: "assistant", content: "还没有可用的 Work。请先新建 Work 并选择 Contributor Agent。" }
          ];
        }
        const task = this.workService.createTask({
          workId: work.id,
          title: args.title || "未命名"
        }, {
          creationOrigin: { originType: "direct_user" }
        });
        return [
          { role: "user", content },
          {
            role: "assistant",
            kind: "receipt",
            content: `已在目标「${work.name}」下创建工作项「${task.title}」`,
            data: { type: "task", task, work }
          }
        ];
      }
      case "agent.create": {
        const agent = this.store.createAgent({
          name: args.name || "未命名 Agent"
        });
        this.onEntityChanged?.("AgentChanged", { action: "created", entity: agent });
        return [
          { role: "user", content },
          {
            role: "assistant",
            kind: "receipt",
            content: `已创建 Agent「${agent.name}」`,
            data: { type: "agent", agent }
          }
        ];
      }
      case "agent.list": {
        const agents = this.store.listAgents();
        const names = agents.map((a) => a.name).join("、");
        return [
          { role: "user", content },
          {
            role: "assistant",
            kind: "receipt",
            content: agents.length ? `当前有 ${agents.length} 个 Agent：${names}` : "暂无 Agent",
            data: { type: "agents", agents }
          }
        ];
      }
      case "agent.delete": {
        const name = args.name;
        const agent = this.store.listAgents().find((a) => a.name === name);
        if (!agent) {
          return [
            { role: "user", content },
            { role: "assistant", content: `未找到名为「${name}」的 Agent`, data: null }
          ];
        }
        this.store.deleteAgent(agent.agentId);
        this.onEntityChanged?.("AgentChanged", { action: "deleted", entity: { agentId: agent.agentId } });
        return [
          { role: "user", content },
          {
            role: "assistant",
            kind: "receipt",
            content: `已删除 Agent「${agent.name}」`,
            data: { type: "agent", agent }
          }
        ];
      }
      case "memory.list": {
        const page = this.store.listMemoryPage({ limit: 20, includeRevoked: true });
        const memories = page.items;
        return [
          { role: "user", content },
          {
            role: "assistant",
            kind: "memory",
            content: memories.length
              ? `显示最近 ${memories.length} 条记忆${page.hasMore ? "，还有更多可在记忆管理中加载" : ""}`
              : "暂无记忆",
            data: { memories, hasMore: page.hasMore, nextCursor: page.nextCursor }
          }
        ];
      }
      default:
        return [
          { role: "user", content },
          {
            role: "assistant",
            content:
              "我可以帮你：建目标、建工作项、查记忆。试试说「建目标 重构 Corptie」或「建工作项 拆巨文件」。",
            data: null
          }
        ];
    }
  }
}
