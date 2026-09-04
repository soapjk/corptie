export class CollaborationHttpClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? defaultBackendUrl()).replace(/\/$/, "");
    this.agentId = required(options.agentId, "agentId");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sessionScope = options.sessionScope ?? {};
  }

  get(path, search = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(search)) {
      if (value == null || value === "") continue;
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry));
    }
    return this.#request(url, { method: "GET" });
  }

  post(path, body = {}) {
    return this.#request(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  patch(path, body = {}) {
    return this.#request(new URL(path, this.baseUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  subscribeCatalogChanges(onChange) {
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      while (!stopped) {
        try {
          const response = await this.fetch(new URL("/events", this.baseUrl), { signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Event stream returned HTTP ${response.status}.`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const type = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
              const data = frame.split("\n").filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim()).join("\n");
              if (!data || !["AgentChanged", "SkillChanged"].includes(type)) continue;
              const event = JSON.parse(data);
              const changedAgentId = event?.payload?.entity?.agentId ?? event?.entity?.agentId ?? null;
              if (type === "SkillChanged" || changedAgentId === this.agentId) onChange();
            }
          }
        } catch (error) {
          if (stopped || error?.name === "AbortError") break;
        }
        if (!stopped) await delay(500);
      }
    };
    run().catch(() => {});
    return () => {
      stopped = true;
      controller.abort();
    };
  }

  async #request(url, init) {
    let response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          "x-corptie-agent-id": this.agentId,
          ...(this.sessionScope.sessionId ? { "x-corptie-session-id": this.sessionScope.sessionId } : {}),
          ...(this.sessionScope.providerBindingId ? { "x-corptie-provider-binding-id": this.sessionScope.providerBindingId } : {}),
          ...(this.sessionScope.workId ? { "x-corptie-work-id": this.sessionScope.workId } : {}),
          ...(this.sessionScope.taskId ? { "x-corptie-task-id": this.sessionScope.taskId } : {})
        }
      });
    } catch (error) {
      const wrapped = new Error(`Corptie backend is unavailable at ${this.baseUrl}: ${error.message}`);
      wrapped.code = "BACKEND_UNAVAILABLE";
      throw wrapped;
    }
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const error = new Error(payload.error || `Corptie backend returned HTTP ${response.status}.`);
      error.code = payload.code || "BACKEND_ERROR";
      error.status = response.status;
      if (payload.details && typeof payload.details === "object") error.details = payload.details;
      throw error;
    }
    return payload;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function defaultBackendUrl() {
  const environment = String(process.env.CORPTIE_ENV ?? "production").trim().toLowerCase();
  const port = process.env.CORPTIE_BACKEND_PORT ?? (environment === "development" ? "47322" : "47321");
  return process.env.CORPTIE_BACKEND_URL ?? `http://127.0.0.1:${port}`;
}

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}
