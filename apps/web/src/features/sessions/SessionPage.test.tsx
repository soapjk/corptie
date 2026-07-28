import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, getSessionMetadata } from "../../lib/api/client";
import { SessionPage } from "./SessionPage";

vi.mock("../../lib/api/client", () => ({
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  performSessionAction: vi.fn(),
  getOperation: vi.fn()
}));

describe("SessionPage", () => {
  beforeEach(() => {
    vi.mocked(getSessionMetadata).mockResolvedValue({
      apiVersion: "1", eventCursor: 1, sessionId: "codex:one",
      branch: null, avatarUrl: null, accountUsage: null, contextUsage: null
    });
    vi.mocked(getSession).mockResolvedValue({
      apiVersion: "1",
      eventCursor: 4,
      session: {
        id: "codex:one",
        title: "Build Web",
        agent: "Codex",
        status: "running",
        progress: 0.6,
        summary: "Working",
        updatedAt: "2026-07-26T12:04:00.000Z",
        createdAt: "2026-07-26T12:00:00.000Z",
        accent: "cyan",
        availableActions: [],
        currentModel: "gpt-test",
        cwd: "/project",
        turnCount: 2,
        items: [
          {
            id: "old-message",
            turnId: "turn-1",
            turnStatus: "complete",
            type: "userMessage",
            title: "You",
            text: "Old request",
            createdAt: "2026-07-26T12:00:00.000Z"
          },
          {
            id: "agent-message",
            turnId: "turn-2",
            turnStatus: "running",
            type: "agentMessage",
            title: "Codex",
            text: "**Done** <script>alert(1)</script> [unsafe](javascript:alert(1))",
            createdAt: "2026-07-26T12:03:00.000Z",
            fileChanges: [{ path: "apps/web/src/App.tsx", kind: "modify" }]
          },
          {
            id: "tool-call",
            turnId: "turn-2",
            turnStatus: "running",
            type: "toolCall",
            title: "Run tests",
            text: "```sh\nnpm test\n```",
            createdAt: "2026-07-26T12:04:00.000Z"
          }
        ]
      }
    });
  });

  it("renders a continuous safe message stream and folds only execution details", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/sessions/codex%3Aone"]}>
          <Routes>
            <Route path="/sessions/:sessionId" element={<SessionPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "Build Web" })).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledWith("codex:one");
    expect(container.querySelectorAll(".timeline-turn")).toHaveLength(0);
    expect(screen.queryByText(/第 [12] 轮/)).not.toBeInTheDocument();
    expect(screen.getByText("Old request")).toBeInTheDocument();
    expect(screen.getByText("Done", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && element.textContent?.includes("<script>alert(1)</script>") === true
    )).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText("apps/web/src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Run tests", { selector: "summary" })).toBeInTheDocument();
  });
});
