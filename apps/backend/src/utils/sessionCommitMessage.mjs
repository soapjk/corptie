export function sanitizeSessionCommitMessage(value) {
  let message = typeof value === "string" ? value.trim() : "";
  message = message.replace(/^(?:commit message|subject)\s*:\s*/i, "");
  message = message.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  message = message.replace(/^([`"'])(.*)\1$/, "$2").replace(/\s+/g, " ").trim();
  return message.slice(0, 72).replace(/[.:;,\s]+$/, "");
}

export function sessionCommitMessagePrompt(plan) {
  const status = plan.statusSummary || "Clean working tree; existing branch commits will be merged.";
  const diffStat = plan.diffStat || "No diff stat available.";
  return [
    "Generate a concise Git commit subject for the current worktree changes.",
    "Reply with exactly one plain-text subject line, without quotes, Markdown, or a prefix.",
    "Use an imperative style and keep it at 72 characters or fewer. Do not call tools.",
    `Branch: ${plan.sourceBranch || "detached HEAD"}`,
    `Git status:\n${status}`,
    `Diff stat:\n${diffStat}`
  ].join("\n\n");
}
