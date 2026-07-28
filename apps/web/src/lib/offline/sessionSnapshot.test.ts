import { beforeEach, describe, expect, it } from "vitest";
import type { SessionsResponse } from "../api/types";
import { readSessionSnapshot, writeSessionSnapshot } from "./sessionSnapshot";

const response: SessionsResponse = {
  apiVersion: "1",
  eventCursor: 42,
  sessions: [{
    id: "codex:1",
    title: "Web frontend",
    agent: "Codex",
    status: "blocked",
    progress: 0.5,
    summary: "SECRET=must-not-be-cached",
    activityStatus: "等待用户",
    updatedAt: "2026-07-26T12:00:00.000Z",
    accent: "cyan",
    avatarUrl: "/api/v1/sessions/codex%3A1/avatar",
    suggestedOptions: [{ id: "approve", label: "Approve secret" }],
    capabilities: { canUndo: true },
    availableActions: [{ id: "approval.approve", enabled: true, risk: "high" }],
    external: {
      provider: "codex",
      connectionStatus: "connected",
      currentModel: "gpt-5",
      currentReasoningLevel: "high",
      cwd: "/Users/private/project",
      sandbox: "danger-full-access",
      approvalPolicy: "never"
    }
  }]
};

describe("read-only Session snapshots", () => {
  beforeEach(() => localStorage.clear());

  it("retains only a non-actionable summary and excludes secret, approval, path, and capability data", () => {
    writeSessionSnapshot(response);
    const raw = localStorage.getItem("corptie:web:snapshot:sessions:v1") ?? "";
    expect(raw).not.toContain("must-not-be-cached");
    expect(raw).not.toContain("Approve secret");
    expect(raw).not.toContain("/Users/private/project");
    expect(raw).not.toContain("danger-full-access");

    const snapshot = readSessionSnapshot();
    expect(snapshot?.eventCursor).toBe(42);
    expect(snapshot?.sessions[0]).toMatchObject({
      id: "codex:1",
      title: "Web frontend",
      summary: "",
      suggestedOptions: null,
      availableActions: [],
      avatarUrl: null
    });
  });

  it("fails closed when stored data is corrupt", () => {
    localStorage.setItem("corptie:web:snapshot:sessions:v1", "{broken");
    expect(readSessionSnapshot()).toBeNull();
  });
});
