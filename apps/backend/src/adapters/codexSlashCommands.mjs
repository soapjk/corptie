// Protocol verified against the installed Codex app-server generated v2 schema.
// UI/account/workspace operations must stay under Corptie's lifecycle owners.
const UI_COMMANDS = {
  new: "请使用新建会话入口。", resume: "请在会话列表选择要恢复的会话。",
  fork: "当前 Corptie 尚未提供会话分叉入口。", side: "当前 Corptie 尚未支持临时侧聊。",
  archive: "请使用会话菜单中的归档操作。", delete: "请使用 Task/会话菜单中的删除操作。",
  permissions: "请在会话设置中修改权限。", approvals: "请在会话设置中修改权限。",
  approve: "请通过对应的审批卡片处理授权。",
  skills: "请通过 Skill 选择入口添加技能。", mention: "请通过消息输入框添加文件引用。",
  mcp: "请在工具管理中查看 MCP 连接。", apps: "请在插件管理中查看应用连接。",
  plugins: "请在插件管理中配置插件。", diff: "请在 Worktree 管理中查看变更。",
  worktree: "请通过 Worktree 管理切换工作目录。", project: "请通过 Work 管理选择项目。",
  login: "请在 Provider 设置中登录。", logout: "请在 Provider 设置中退出登录。",
  feedback: "请通过反馈入口提交；此命令不会自动上传日志。",
  plan: "当前命令入口尚未适配原生 Plan 模式。",
  fast: "当前命令入口尚未适配 Fast 服务档位。",
  memories: "请使用记忆设置入口。", import: "当前命令入口尚未支持配置导入。",
  experimental: "请在 Provider 设置中管理实验功能。",
  init: "请直接发送“为当前项目生成 AGENTS.md”。",
  app: "当前已在 Corptie 中打开会话。", quit: "请使用 Corptie 的退出菜单。",
  exit: "请使用 Corptie 的退出菜单。", clear: "用法：/clear（不带参数）。",
  statusline: "这是 Codex 终端界面设置，Corptie 不使用该界面。",
  theme: "请使用 Corptie 外观设置。", keymap: "这是 Codex 终端快捷键设置。"
};

export function commandError(message, code = "PROVIDER_COMMAND_UNSUPPORTED") {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

export async function executeCodexSlashCommand(request, threadId, command) {
  const args = command.arguments;
  const noArgs = () => {
    if (args) throw commandError(`/${command.name} 不接受参数。`, "INVALID_COMMAND_ARGUMENTS");
  };
  switch (command.name) {
    case "help":
      noArgs();
      return { text: "可执行：/goal [目标|edit 目标|pause|resume|clear]、/compact、/review [要求]、/ps、/stop（/clean）、/model [模型ID]、/reasoning <级别>、/rename <名称>、/status、/clear。\n其他命令需使用对应的 Corptie 界面，或尚未支持；不会作为普通消息发送。" };
    case "goal": {
      let result;
      if (!args) result = await request("thread/goal/get", { threadId });
      else if (args === "clear") {
        await request("thread/goal/clear", { threadId });
        return { text: "Goal 已清除。" };
      } else if (["pause", "resume"].includes(args)) {
        result = await request("thread/goal/set", { threadId, status: args === "pause" ? "paused" : "active" });
      } else {
        const objective = args === "edit" ? "" : args.replace(/^edit\s+/, "");
        if (!objective || [...objective].length > 4000) {
          throw commandError("用法：/goal <目标> 或 /goal edit <目标>；目标须为 1–4000 个字符。", "INVALID_COMMAND_ARGUMENTS");
        }
        result = await request("thread/goal/set", { threadId, objective, status: "active" });
      }
      const goal = result?.goal;
      return { goal: goal ?? null, text: goal
        ? `Goal：${goal.objective}\n状态：${goal.status}\n已用 tokens：${goal.tokensUsed ?? 0}`
        : "当前会话没有 Goal。" };
    }
    case "compact":
      noArgs();
      await request("thread/compact/start", { threadId });
      return { text: "已请求压缩会话上下文，完成状态以运行时事件为准。" };
    case "review":
      await request("review/start", { threadId, delivery: "inline", target: args
        ? { type: "custom", instructions: args } : { type: "uncommittedChanges" } });
      return { text: "已启动代码审查。" };
    case "ps": {
      noArgs();
      const result = await request("thread/backgroundTerminals/list", { threadId });
      return { text: JSON.stringify(result, null, 2) };
    }
    case "stop": case "clean":
      noArgs();
      await request("thread/backgroundTerminals/clean", { threadId });
      return { text: "已请求停止本会话的后台终端。" };
    default:
      throw commandError(`/${command.name}：${UI_COMMANDS[command.name] ?? "当前 Corptie 未适配此命令。输入 /help 查看可执行命令。"}`);
  }
}
