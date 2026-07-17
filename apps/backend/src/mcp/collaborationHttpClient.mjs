export class CollaborationHttpClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? defaultBackendUrl()).replace(/\/$/, "");
    this.agentId = required(options.agentId, "agentId");
    this.fetch = options.fetch ?? globalThis.fetch;
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

  async #request(url, init) {
    let response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          "x-corptie-agent-id": this.agentId
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
      throw error;
    }
    return payload;
  }
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
