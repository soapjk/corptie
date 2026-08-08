export class HostToolCatalog {
  constructor(namespaces = []) {
    this.toolsByName = new Map();
    for (const namespace of namespaces) this.register(namespace);
  }

  register(namespace) {
    const id = requiredText(namespace?.id, "namespace.id");
    if (!Array.isArray(namespace?.tools) || typeof namespace?.execute !== "function") {
      throw new TypeError(`Host tool namespace ${id} requires tools and execute().`);
    }
    for (const definition of namespace.tools) {
      const name = requiredText(definition?.name, "tool.name");
      if (this.toolsByName.has(name)) throw new TypeError(`Host tool is already registered: ${name}`);
      this.toolsByName.set(name, Object.freeze({ id, definition: Object.freeze({ ...definition }), execute: namespace.execute }));
    }
    return this;
  }

  definitions() {
    return Array.from(this.toolsByName.values(), ({ definition }) => definition);
  }

  async execute(input = {}) {
    const name = requiredText(input.tool, "tool");
    const registered = this.toolsByName.get(name);
    if (!registered) {
      const error = new Error(`Unsupported Corptie host tool: ${name}`);
      error.code = "HOST_TOOL_UNSUPPORTED";
      throw error;
    }
    return registered.execute({
      ...input,
      tool: name,
      arguments: input.arguments ?? {}
    });
  }
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`Host Tool ${field} is required.`);
  return normalized;
}
