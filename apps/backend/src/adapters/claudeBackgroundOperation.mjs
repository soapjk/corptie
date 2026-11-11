import { assistantText } from "./claudeMessageProjection.mjs";
import {
  claudeSecretValues, claudeRuntimeEnvironment, claudeSdkResultError, normalizeClaudeProviderError
} from "../agent-provider/providers/claudeProviderConfiguration.mjs";

export async function runClaudeBackgroundPrompt(input = {}, { queryFactory, environment }) {
    const executionPolicy = input.executionPolicy ?? "legacy";
    if (!["legacy", "no-tools"].includes(executionPolicy)
      || (executionPolicy === "no-tools" && (input.permissionProfile ?? "read-only") !== "read-only")) {
      throw Object.assign(new Error("Unsupported background execution policy."), { code: "CAPABILITY_UNSUPPORTED" });
    }
    // SDK-level isolation, not a prompt-based restriction. Empty built-in tools
    // and strict empty MCP configuration must travel together.
    const isolation = executionPolicy === "no-tools" ? {
      tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], plugins: [], agents: {}, hooks: {},
      systemPrompt: input.developerInstructions || "Return only the requested text from the supplied input.",
      canUseTool: async () => ({ behavior: "deny", message: "Tools are disabled for this background operation." })
    } : {};
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(input.signal.reason);
    input.signal?.throwIfAborted();
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeoutMs = input.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => abortController.abort(Object.assign(new Error("Background model call timed out."), {
      code: "BACKGROUND_TIMEOUT", phase: "wait_completion", timeoutMs
    })), timeoutMs);
    let latestText = "";
    let operation;
    try {
      operation = queryFactory({
        prompt: input.prompt,
        options: {
          cwd: input.cwd,
          persistSession: false,
          model: input.model || undefined,
          env: claudeRuntimeEnvironment(environment()),
          permissionMode: "plan",
          maxTurns: 1,
          abortController,
          ...isolation
        }
      });
      for await (const message of operation) {
        abortController.signal.throwIfAborted();
        if (message?.type === "assistant") {
          latestText = assistantText(message.message) || latestText;
        }
        if (message?.type === "result") {
          const failure = claudeSdkResultError(message, {
            secretValues: claudeSecretValues(environment())
          });
          if (failure) throw failure;
          latestText = (typeof message.result === "string" ? message.result.trim() : "") || latestText;
        }
      }
      abortController.signal.throwIfAborted();
      return { text: latestText };
    } catch (error) {
      // Keep cancellation and the shared timeout contract distinct from upstream model errors.
      if (abortController.signal.aborted) throw abortController.signal.reason;
      throw normalizeClaudeProviderError(error, {
        secretValues: claudeSecretValues(environment())
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", forwardAbort);
      // Release the subprocess even when iteration fails or is cancelled.
      await operation?.close?.();
    }
  }
