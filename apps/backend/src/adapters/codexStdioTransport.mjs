import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { nowIso } from "../utils/timestamps.mjs";

/// Owns exactly one app-server generation and its outstanding RPC requests.
/// Thread state and interactive request policy remain in the adapter.
export class CodexStdioTransport {
  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.env = options.env ?? process.env;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    // Process bootstrap may be slower than an ordinary RPC during app launch.
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 30000;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.onNotification = options.onNotification ?? (() => {});
    this.onServerRequest = options.onServerRequest ?? (() => {});
    this.onBeforeClear = options.onBeforeClear ?? (() => {});
    this.onCleared = options.onCleared ?? (() => {});
    this.process = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializePromise = null;
    this.processGeneration = 0;
    this.activeProcessGeneration = 0;
  }

  initialize() {
    if (this.initialized && this.process) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;

    const generation = ++this.processGeneration;
    const initializing = this.#initializeProcess(generation);
    const trackedInitialization = initializing.finally(() => {
      if (this.initializePromise === trackedInitialization) this.initializePromise = null;
    });
    this.initializePromise = trackedInitialization;
    // Provider initialization is also started by background readiness work.
    // Keep the shared promise observably rejected for callers, while attaching
    // an internal rejection observer so a detached consumer can never turn a
    // Provider timeout into an unhandled rejection that terminates Backend.
    trackedInitialization.catch(() => {});
    return trackedInitialization;
  }

  async #initializeProcess(generation) {
    const env = typeof this.env === "function" ? this.env() : this.env;
    const child = this.spawnProcess(typeof this.command === "function" ? this.command() : this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });
    this.process = child;
    this.activeProcessGeneration = generation;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.activeProcessGeneration !== generation || this.process !== child) return;
      this.onDiagnostic({
        method: "stderr",
        params: { chunk, createdAt: nowIso() }
      });
    });

    child.on("exit", (code, signal) => {
      this.#clearProcessGeneration(
        generation,
        child,
        new Error(`Codex app-server exited before response (${code ?? signal})`)
      );
    });
    child.on("error", (cause) => {
      this.#clearProcessGeneration(
        generation,
        child,
        new Error(`Codex app-server failed to start: ${cause?.message ?? cause}`, { cause })
      );
    });

    const lineReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    this.readline = lineReader;

    lineReader.on("line", (line) => {
      if (this.activeProcessGeneration !== generation || this.process !== child) return;
      this.handleLine(line);
    });

    try {
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: "corptie",
          title: "Corptie",
          version: "0.5.4"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      }, this.initializationTimeoutMs);
      this.runtimeUserAgent = initialized?.userAgent ?? null;
      if (this.activeProcessGeneration !== generation || this.process !== child) {
        throw new Error("Codex app-server initialization was superseded by a newer process generation.");
      }
      this.initialized = true;
    } catch (error) {
      if (this.activeProcessGeneration === generation && this.process === child) {
        child.kill("SIGTERM");
        lineReader.close();
        this.#clearProcessGeneration(generation, child, error);
      }
      throw error;
    }
  }

  async close() {
    const child = this.process;
    const generation = this.activeProcessGeneration;
    if (!child) return;

    // Allow a later initialize() to create a new generation immediately. The
    // old process may emit exit asynchronously; its callback must not tear down
    // that newer generation.
    this.initializePromise = null;
    this.#clearProcessGeneration(
      generation,
      child,
      new Error("Codex app-server was closed before response.")
    );
    child.kill("SIGTERM");
  }

  #clearProcessGeneration(generation, child, error) {
    if (this.activeProcessGeneration !== generation || this.process !== child) return false;
    this.onBeforeClear();
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
    this.initialized = false;
    this.process = null;
    this.readline?.close();
    this.readline = null;
    this.activeProcessGeneration = 0;
    this.onCleared();
    return true;
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    const child = this.process;
    const generation = this.activeProcessGeneration;
    if (!child || !generation || !child.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const message = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(id)?.generation === generation) this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        generation,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.onDiagnostic({
        method: "parseError",
        params: {
          line,
          error: error.message,
          createdAt: nowIso()
        }
      });
      return;
    }

    if ("id" in message && "method" in message) {
      this.onServerRequest(message);
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(codexResponseError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.onNotification(message);
  }

  respondToServerRequest(id, result) {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    return Promise.resolve({ ok: true });
  }

  rejectUnsupportedRequest(id) {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify({
      id, error: { code: -32601, message: "Unsupported interactive request" }
    })}\n`);
  }
}

export function codexResponseError(payload) {
  const error = new Error(JSON.stringify(payload));
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (/^(?:no rollout found for thread id\b|thread not found:|failed to resolve rollout path\b.*\bfile does not exist$)/i.test(message)) {
    error.code = "PROVIDER_SESSION_UNAVAILABLE";
    error.safeToRetry = true;
  } else if (/^(?:thread not loaded:|invalid paginated history lineage\b.*\bmissing source rollout$)/i.test(message)) {
    // thread/start is intentionally pre-Turn. If the app-server process dies
    // before Corptie commits the route, that empty in-memory thread has no
    // rollout and cannot be recovered in a new process. No user Delivery was
    // dispatched, so the coordinator may replace only this exact empty target.
    error.code = "PROVIDER_EMPTY_THREAD_UNRECOVERABLE";
    error.safeToRecreate = true;
  }
  return error;
}
