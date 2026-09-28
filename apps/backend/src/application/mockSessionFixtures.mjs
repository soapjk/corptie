import { randomUUID } from "node:crypto";

const statuses = new Set(["running", "blocked", "complete", "failed", "cancelled"]);

export function createMockSessionFixtures({ sessions, now, emitEvent }) {
  function createSession(input = {}) {
    const id = randomUUID();
    const session = {
      id,
      title: input.title || "Review sidebar layout",
      agent: input.agent || "Codex",
      status: statuses.has(input.status) ? input.status : "running",
      progress: Number(input.progress ?? 0.08),
      summary: input.summary || "Reading project files and preparing a change plan.",
      updatedAt: now(),
      accent: input.accent || "cyan"
    };
    sessions.set(id, session);
    emitEvent("TaskCreated", { session });
    return session;
  }

  function seedSessions() {
    createSession({
      title: "Implement floating panel shell",
      agent: "Codex",
      progress: 0.42,
      summary: "Building the macOS panel and task card surface.",
      accent: "mint"
    });
    createSession({
      title: "Compare Claude Code adapter paths",
      agent: "Claude Code",
      progress: 0.64,
      summary: "Waiting for a decision on CLI versus SDK integration.",
      status: "blocked",
      accent: "violet"
    });
    createSession({
      title: "Draft theme token schema",
      agent: "Research",
      progress: 0.88,
      summary: "Theme tokens are ready for review.",
      accent: "amber"
    });
  }

  function updateMockProgress() {
    for (const session of sessions.values()) {
      if (session.status !== "running") continue;
      const nextProgress = Math.min(1, session.progress + Math.random() * 0.08);
      session.progress = Number(nextProgress.toFixed(2));
      session.updatedAt = now();
      if (session.progress >= 1) {
        session.status = "complete";
        session.summary = "Finished and ready for review.";
        emitEvent("TaskCompleted", { session });
      } else if (Math.random() < 0.08) {
        session.status = "blocked";
        session.summary = "Needs user confirmation before continuing.";
        emitEvent("TaskBlocked", { session });
      } else {
        session.summary = "Working in the background.";
        emitEvent("TaskProgressChanged", { session });
      }
    }
  }

  return { seedSessions, updateMockProgress };
}
