export async function resolveWorkspaceTransitionRuntime(providerId, runtimes = {}) {
  const runtime = providerId ? runtimes[providerId] : null;
  if (!runtime || typeof runtime !== "object" || typeof runtime.manager !== "object") {
    const error = new Error(`Session Provider ${providerId ?? "unknown"} has no workspace transition manager.`);
    error.code = "PROVIDER_WORKSPACE_TRANSITION_UNSUPPORTED";
    throw error;
  }
  const options = typeof runtime.loadOptions === "function"
    ? await runtime.loadOptions()
    : {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    const error = new Error(`Session Provider ${providerId} returned invalid workspace transition options.`);
    error.code = "PROVIDER_WORKSPACE_TRANSITION_OPTIONS_INVALID";
    throw error;
  }
  return { manager: runtime.manager, options };
}
