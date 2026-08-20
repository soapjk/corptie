// Provider-neutral, hidden Background Agent adapter for non-standard Skill packages.
// The Agent only proposes relative paths; SkillRegistryService remains the authority that
// validates containment, manifests, MCP descriptors, resources, and installation output.

export function createSkillPackageDiscoveryAssistant({ backgroundAgent } = {}) {
  if (!backgroundAgent || typeof backgroundAgent.run !== "function") {
    throw new TypeError("Skill package discovery assistance requires a Background Agent Service.");
  }
  return async ({ sourceRoot, skillRoot, markerPath, mcpDescriptorHints = [] }) => {
    const result = await backgroundAgent.run({
      purpose: "skill-package-discovery",
      cwd: sourceRoot,
      allowedRoots: [sourceRoot],
      permissionProfile: "read-only",
      developerInstructions: [
        "Analyze a local Skill package without modifying any file.",
        "Return exactly one JSON object and no Markdown.",
        "Only propose paths that already exist inside the allowed source root.",
        "The object schema is: { packageRoot: string, mcpDescriptor: string, confidence: number, evidence: string[] }.",
        "packageRoot is relative to the source root. mcpDescriptor is relative to packageRoot.",
        "Do not propose commands, configuration edits, downloads, or generated resources."
      ].join("\n"),
      prompt: [
        "Determine the package root and MCP descriptor belonging to this Skill.",
        `Skill root: ${relativeForPrompt(sourceRoot, skillRoot)}`,
        `SKILL.md: ${relativeForPrompt(sourceRoot, markerPath)}`,
        `MCP descriptor hints: ${mcpDescriptorHints.length > 0 ? mcpDescriptorHints.join(", ") : "none"}`,
        "Inspect package manifests, documentation, and path references. Prefer explicit ownership evidence."
      ].join("\n"),
      timeoutMs: 120_000
    });
    return parseDiscoveryPlan(result?.text);
  };
}

export function parseDiscoveryPlan(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw discoveryError("SKILL_ASSISTANCE_INVALID", "后台 Agent 没有返回 Skill Package 安装计划。");
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced || raw;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("root must be an object");
    return parsed;
  } catch (error) {
    throw discoveryError(
      "SKILL_ASSISTANCE_INVALID",
      `后台 Agent 返回的 Skill Package 安装计划不是有效 JSON：${error?.message ?? String(error)}`
    );
  }
}

function relativeForPrompt(root, value) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return value === root ? "." : (value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

function discoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
