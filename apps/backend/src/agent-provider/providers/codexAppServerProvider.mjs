import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const CODEX_APP_SERVER_PROVIDER_ID = "codex-app-server";
export const CODEX_TOOL_SCHEMA_CAPABILITIES = Object.freeze({
  bootstrapAttach: true,
  appendInPlace: false,
  replaceAtTurnBoundary: false,
  generatedMcpRefresh: false,
  restrictedGateway: true,
  bindingReplacement: true,
  // Revision 5 invalidates receipts issued before Corptie distinguished
  // thread/start schema acceptance from thread/fork schema inheritance.
  capabilityRevision: "codex-app-server:tool-schema:5"
});

export function createCodexAppServerProvider(operations, options = {}) {
  return new CallbackAgentProvider({
    id: CODEX_APP_SERVER_PROVIDER_ID,
    displayName: "Codex",
    transport: "app-server",
    aliases: ["codex"],
    runtime: { lifecycle: "managed" },
    metadata: {
      ...(options.metadata ?? {}),
      toolSchemaCapabilities: CODEX_TOOL_SCHEMA_CAPABILITIES,
      sessionRecovery: {
        revision: "codex-app-server:session-recovery:1",
        capabilities: [
          "explicit_replay", "system_context_injection", "tool_result_history", "max_context_estimation"
        ],
        maxContextTokens: 128_000
      }
    },
    capabilities: options.capabilities ?? [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
      ...(typeof operations.disconnectSession === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT]
        : []),
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_BINDING_PROBE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND_IMAGE,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
      AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
      ...(typeof operations.bindWorkspace === "function" && typeof operations.inspectWorkspaceBinding === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND]
        : []),
      AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
      AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
      AGENT_PROVIDER_CAPABILITIES.SKILL_LAZY_LOAD,
      AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES,
      AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE
    ]
  }, {
    ...operations,
    probeToolSchemaCapabilities: operations.probeToolSchemaCapabilities
      ?? (() => CODEX_TOOL_SCHEMA_CAPABILITIES)
  });
}

export function codexToolHostAttachment(attachment, providerOptions = {}) {
  if (!attachment?.actorId || !Array.isArray(attachment?.tools)) {
    throw new TypeError("Codex Tool Host attachment requires an actor id and tool catalog.");
  }
  const skillMcpServers = Object.fromEntries(Object.entries(attachment.mcpServers ?? {}).map(([name, server]) => [
    name,
    codexMcpServer(server)
  ]));
  const configuredMcpServers = providerOptions.config?.mcp_servers ?? {};
  assertNoMcpServerConflicts(configuredMcpServers, skillMcpServers);
  return {
    ...providerOptions,
    config: {
      ...(providerOptions.config ?? {}),
      mcp_servers: { ...configuredMcpServers, ...skillMcpServers }
    },
    dynamicTools: attachment.tools.map((tool) => ({ ...tool })),
    dynamicToolAgentId: attachment.actorId,
    dynamicToolMetadata: attachment.metadata ?? null
  };
}

function codexMcpServer(server = {}) {
  const result = { ...server };
  delete result.type;
  return result;
}

function assertNoMcpServerConflicts(existing, incoming) {
  const conflict = Object.keys(incoming).find((name) => Object.prototype.hasOwnProperty.call(existing, name));
  if (!conflict) return;
  const error = new Error(`MCP server name conflicts with an existing Provider server: ${conflict}`);
  error.code = "MCP_SERVER_NAME_CONFLICT";
  throw error;
}
