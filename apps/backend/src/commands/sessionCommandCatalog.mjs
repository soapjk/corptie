import { AGENT_PROVIDER_CAPABILITIES as C } from "../agent-provider/contracts.mjs";

// Shared product catalog. Provider-specific command names are advertised by
// the adapter, never selected by a Provider-name check in a client or gateway.
export const SESSION_COMMAND_CATALOG = Object.freeze([
  { name: "help", usage: "/help", summary: "查看可用命令", common: true },
  { name: "status", usage: "/status", summary: "查看会话状态", common: true },
  { name: "model", usage: "/model [模型ID]", summary: "查看或切换模型", capability: C.MODEL_LIST, common: true },
  { name: "reasoning", usage: "/reasoning <级别>", summary: "切换推理强度", capability: C.REASONING_SWITCH, common: true },
  { name: "rename", usage: "/rename <名称>", summary: "重命名会话", capability: C.SESSION_RENAME, common: true },
  { name: "clear", usage: "/clear", summary: "清空会话上下文", capability: C.CONVERSATION_CLEAR, common: true, requiresConfirmation: true },
  { name: "goal", usage: "/goal [目标|edit 目标|pause|resume|clear]", summary: "管理会话目标" },
  { name: "compact", usage: "/compact", summary: "压缩上下文" },
  { name: "review", usage: "/review [要求]", summary: "开始代码审查" },
  { name: "ps", usage: "/ps", summary: "查看后台终端" },
  { name: "stop", usage: "/stop", summary: "停止后台终端" },
  { name: "clean", usage: "/clean", summary: "停止后台终端（stop 别名）" }
]);

export function sessionCommandError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, status: statusCode, commandStage: "validation" });
}

export function validateSessionCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)
      || Object.keys(command).some(key => !["name", "arguments"].includes(key))
      || typeof command.name !== "string" || typeof command.arguments !== "string"
      || command.arguments.length > 16000) {
    throw sessionCommandError("INVALID_COMMAND_ARGUMENTS", "命令格式或参数无效。");
  }
  const descriptor = SESSION_COMMAND_CATALOG.find(item => item.name === command.name);
  if (!descriptor) throw sessionCommandError("PROVIDER_COMMAND_UNSUPPORTED", "未知命令；输入 /help 查看可用命令。");
  const args = command.arguments;
  if (["help", "status", "clear", "compact", "ps", "stop", "clean"].includes(command.name) && args) {
    throw sessionCommandError("INVALID_COMMAND_ARGUMENTS", `/${command.name} 不接受参数。`);
  }
  if (["rename", "reasoning"].includes(command.name) && !args.trim()) {
    throw sessionCommandError("INVALID_COMMAND_ARGUMENTS", descriptor.usage);
  }
  if (command.name === "goal" && args && !["pause", "resume", "clear"].includes(args)) {
    const objective = args === "edit" ? "" : args.replace(/^edit\s+/, "");
    if (!objective.trim() || [...objective].length > 4000) {
      throw sessionCommandError("INVALID_COMMAND_ARGUMENTS", "Goal 目标须为 1–4000 个字符。");
    }
  }
  return descriptor;
}

export function sessionCommandPermissions(command) {
  if (command.name === "clear") return ["sessions.clear"];
  if (["stop", "clean"].includes(command.name)) return ["sessions.commands", "sessions.stop"];
  if (["help", "status", "ps"].includes(command.name)
      || (["goal", "model"].includes(command.name) && !command.arguments)) return ["messages.read"];
  return ["sessions.commands"];
}

export function sessionCommandNeedsConfirmation(command) {
  return command.name === "clear" || (command.name === "goal" && command.arguments === "clear");
}

export function sessionCommandAvailability(descriptor, provider, command = null) {
  const capabilities = new Set(provider.capabilities ?? []);
  const capability = descriptor.name === "model" && command?.arguments ? C.MODEL_SWITCH : descriptor.capability;
  if (descriptor.common) return !capability || capabilities.has(capability);
  return capabilities.has(C.CONVERSATION_COMMAND)
    && (provider.metadata?.conversationCommands ?? []).includes(descriptor.name);
}
