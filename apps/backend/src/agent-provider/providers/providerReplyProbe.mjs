import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentForCommand } from "../../utils/externalCommand.mjs";

export const PROVIDER_PROBE_PROMPT = "Reply with exactly CORPTIE_OK. Do not use tools or read files.";
const replyIsValid = (text) => typeof text === "string" && text.trim() === "CORPTIE_OK";

// These adapters use the selected CLI in a fresh empty directory. They never
// create a product Session or attach the user's Work, messages or tools.
export const createCodexReplyProbe = (options = {}) => createProbe({
  args: () => ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", PROVIDER_PROBE_PROMPT],
  validate: (events) => events.some((event) => event.type === "turn.completed")
    && !events.some((event) => ["error", "turn.failed"].includes(event.type))
    && events.some((event) => event.type === "item.completed"
      && event.item?.type === "agent_message" && replyIsValid(event.item.text)),
  ...options
});

export const createClaudeReplyProbe = (options = {}) => createProbe({
  args: () => ["-p", PROVIDER_PROBE_PROMPT, "--output-format", "json", "--no-session-persistence",
    "--tools", "", "--strict-mcp-config", "--disable-slash-commands"],
  validate: (events) => events.some((event) => event.type === "result"
    && event.subtype === "success" && event.is_error !== true && replyIsValid(event.result)),
  ...options
});

export const createOpenClackyReplyProbe = (options = {}) => createProbe({
  args: () => ["agent", "--json", "--mode", "confirm_safes", "-m", PROVIDER_PROBE_PROMPT],
  validate: (events) => events.some((event) => event.type === "complete")
    && !events.some((event) => ["error", "tool_error", "request_confirmation"].includes(event.type))
    && events.some((event) => event.type === "assistant_message" && replyIsValid(event.content)),
  ...options
});

function createProbe({ args, validate, environment = () => process.env, execute = runProbeProcess, timeoutMs = 30_000 }) {
  return async (path, { signal } = {}) => {
    const cwd = await mkdtemp(join(tmpdir(), "corptie-provider-check-"));
    try {
      const output = await execute(path, args(), {
        cwd, env: environmentForCommand(path, await environment()), timeoutMs, signal
      });
      // Ignore banners, but require actual protocol-level assistant output and
      // successful completion. A version/help banner or empty exit is not proof.
      let events;
      try { events = [JSON.parse(output)]; } catch { events = output.split(/\r?\n/).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }); }
      if (!validate(events)) throw new Error("未收到有效回复，请检查 Provider 配置后重试。");
      return { ok: true };
    } catch (error) {
      if (error.code === "PROBE_TIMEOUT") throw new Error("检测超时，请重试。");
      if (error.code === "PROBE_PROCESS_FAILED") throw new Error("检测失败，请检查 Provider 登录、网络或配置后重试。");
      throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

// Kill the process group on timeout so a CLI's model/helper children cannot
// outlive the probe. Bound output and never expose stderr (it may contain keys).
export function runProbeProcess(path, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("检测已取消。"));
    const child = spawn(path, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let stopped = false;
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      reject(Object.assign(new Error("Provider probe failed."), { code }));
    };
    const abort = () => stop("PROBE_CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("PROBE_TIMEOUT"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 256 * 1024) stop("PROBE_PROCESS_FAILED");
    });
    child.once("error", () => stop("PROBE_PROCESS_FAILED"));
    child.once("close", (code) => {
      if (stopped) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code !== 0) return stop("PROBE_PROCESS_FAILED");
      stopped = true;
      resolve(output);
    });
  });
}
