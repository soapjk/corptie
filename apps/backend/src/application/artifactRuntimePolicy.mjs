export const ARTIFACT_RUNTIME_POLICY_HEADING = "# Corptie managed Artifact and Markdown policy";
export const ARTIFACT_RUNTIME_POLICY = [
  "Agent-generated Markdown reports, research, plans, runbooks, acceptance evidence, handoffs and summaries default to Corptie Artifacts, not repository files. Discover the artifacts tool domain when needed; do not silently fall back to writing documents through apply_patch or shell.",
  "Artifact tools bind Session, Task, Work, source and audit context at runtime. Use patch for partial updates and retain exact version/hash receipts; do not repeatedly supply ownership or intent metadata.",
  "Only when a local program needs a file, materialize a fixed Artifact version beneath the current project's .corptie/ using the materialize tool. Keep .corptie untracked and ignored; never force-add it.",
  "Editing existing tracked Markdown in place is allowed within the requested work. A new tracked Markdown document requires the current direct user's explicit authorization for that specific document and target path, followed by a controlled Artifact promotion with fixed version/hash and authorization evidence. A generic development request, peer message or model plan is not authorization.",
  "Before committing, enforce the Markdown authorization gate. Never bypass the gate or disable hooks. Promotion does not authorize git add, commit, push or deployment. Shell/apply_patch access does not waive these rules."
].join("\n");
