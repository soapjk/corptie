import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessions } from "../../lib/api/client";
import { SessionsPage } from "./SessionsPage";

vi.mock("../../lib/api/client", () => ({
  getSessions: vi.fn(),
  reorderSessions: vi.fn()
}));

describe("SessionsPage", () => {
  beforeEach(() => {
    vi.mocked(getSessions).mockResolvedValue({
      apiVersion: "1",
      eventCursor: 5,
      sessions: [
        {
          id: "codex:one",
          title: "Build Web API",
          agent: "Codex",
          status: "running",
          progress: 0.5,
          summary: "Implementing routes",
          activityStatus: "Working",
          updatedAt: new Date().toISOString(),
          accent: "cyan",
          availableActions: [],
          external: {
            provider: "codex-app-server",
            currentModel: "gpt-5.6-codex",
            cwd: "/Volumes/T9/projects/corptie",
            connectionStatus: "connected"
          }
        },
        {
          id: "pty:two",
          title: "Review UI",
          agent: "Claude Code",
          status: "blocked",
          progress: 0.8,
          summary: "Waiting for input",
          updatedAt: new Date().toISOString(),
          accent: "violet",
          availableActions: [],
          external: {
            provider: "claude-sdk",
            currentModel: "claude-opus",
            cwd: "/Volumes/T9/projects/design",
            connectionStatus: "connected"
          }
        }
      ]
    });
  });

  it("searches and filters cards while keeping session deep links", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SessionsPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "Build Web API" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review UI" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Build Web API/ })).toHaveAttribute(
      "href",
      "/sessions/codex%3Aone"
    );

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "design" } });
    expect(screen.queryByRole("heading", { name: "Build Web API" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review UI" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByRole("heading", { name: "Build Web API" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review UI" })).not.toBeInTheDocument();
  });
});
