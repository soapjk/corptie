import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAttention } from "../../lib/api/client";
import { AttentionPage } from "./AttentionPage";

vi.mock("../../lib/api/client", () => ({
  getAttention: vi.fn(),
  markAttentionRead: vi.fn(),
  performSessionAction: vi.fn(),
  getOperation: vi.fn()
}));

describe("AttentionPage", () => {
  beforeEach(() => {
    vi.mocked(getAttention).mockResolvedValue({
      apiVersion: "1",
      eventCursor: 8,
      count: 2,
      runningCount: 3,
      items: [
        {
          id: "approval",
          kind: "high-risk-approval",
          priority: 1,
          sessionId: "codex:one",
          sessionTitle: "Fix CI",
          agent: "Codex",
          summary: "Approve npm install",
          updatedAt: new Date().toISOString(),
          contextItemId: "approval-1",
          availableActions: []
        },
        {
          id: "input",
          kind: "input-required",
          priority: 3,
          sessionId: "codex:two",
          sessionTitle: "Web API",
          agent: "Claude Code",
          summary: "Choose an authentication strategy",
          updatedAt: new Date().toISOString(),
          availableActions: []
        }
      ]
    });
  });

  it("shows the queue count in server order and links to session context", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AttentionPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "待处理 2" })).toBeInTheDocument();
    expect(screen.getByText("3 个 Session 正在运行")).toBeInTheDocument();
    expect(screen.getAllByRole("article").map((card) => card.textContent)).toEqual([
      expect.stringContaining("Fix CI"),
      expect.stringContaining("Web API")
    ]);
    expect(screen.getByRole("link", { name: "查看并处理" })).toHaveAttribute(
      "href",
      "/sessions/codex%3Aone#item-approval-1"
    );
  });
});
