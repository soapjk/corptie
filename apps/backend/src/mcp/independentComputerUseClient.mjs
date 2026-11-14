import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

// One native process per call: no stale AX handles, captured frames, held keys,
// or resident capture loop across turns. Abort/timeout/transport close kills it.
export class IndependentComputerUseClient {
  #children = new Set();
  #closed = false;
  constructor({ helperPath, stateRoot, spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
    if (!isAbsolute(helperPath ?? "") || !isAbsolute(stateRoot ?? "")) throw new Error("Absolute helperPath and stateRoot are required");
    Object.assign(this, { helperPath, stateRoot, spawnProcess, timeoutMs });
  }
  async call(method, params = {}, { signal } = {}) {
    if (this.#closed) throw new Error("Native client closed");
    signal?.throwIfAborted();
    if (this.#children.size) throw new Error("Computer Use is busy");
    const id = randomUUID();
    const child = this.spawnProcess(this.helperPath, [], {
      cwd: this.stateRoot, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", CORPTIE_COMPUTER_USE_STATE_ROOT: this.stateRoot }
    });
    this.#children.add(child);
    return new Promise((resolve, reject) => {
      let buffer = "", settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.stdin.destroy();
        child.kill("SIGKILL");
        // Retain the busy guard until the OS confirms native work has stopped.
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(signal.reason ?? new Error("Cancelled"));
      const timer = setTimeout(() => finish(new Error("Native request timed out")), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", error => { this.#children.delete(child); finish(error); });
      child.once("close", () => { this.#children.delete(child); finish(new Error("Native helper exited before reply")); });
      child.stdin.on("error", error => finish(error));
      child.stderr.resume(); // Never log captured UI / typed secrets.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 24 * 1024 * 1024) return finish(new Error("Native reply too large"));
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, end));
          if (reply.id !== id) throw new Error("Native reply id mismatch");
          if (reply.error) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          finish(null, reply.result);
        } catch (error) { finish(error); }
      });
      child.stdin.end(`${JSON.stringify({ id, method, params })}\n`);
      if (signal?.aborted) abort();
    });
  }
  close() { this.#closed = true; for (const child of this.#children) child.kill("SIGKILL"); }
}
