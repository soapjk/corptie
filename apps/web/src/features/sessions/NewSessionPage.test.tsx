import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBootstrap } from "../../lib/api/client";
import { NewSessionPage } from "./NewSessionPage";

vi.mock("../../lib/api/client", () => ({
  getBootstrap: vi.fn(),
  createSession: vi.fn()
}));

describe("NewSessionPage", () => {
  afterEach(cleanup);

  it("uses Mac-provided trusted workspaces and defaults without a free-form path", async () => {
    vi.mocked(getBootstrap).mockResolvedValue({
      apiVersion: "1",
      environment: "development",
      serverTime: "2026-07-26T12:00:00.000Z",
      eventCursor: 1,
      csrfToken: "csrf",
      device: { id: "d", name: "Phone", permission: "full-control", createdAt: "2026-07-26T12:00:00.000Z" },
      features: {},
      preferences: {},
      creation: {
        workspaces: [{ name: "corptie", path: "/project/corptie" }],
        agents: ["codex", "claude"],
        models: { codex: [{ id: "gpt-test", name: "GPT Test" }], claude: [] },
        defaults: {
          agent: "codex",
          workspace: "/project/corptie",
          codexModel: "gpt-test",
          sandbox: "workspace-write",
          approvalPolicy: "on-request"
        }
      }
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><NewSessionPage /></MemoryRouter>
      </QueryClientProvider>
    );
    expect(await screen.findByRole("heading", { name: "新建 Session" })).toBeInTheDocument();
    expect(screen.getByLabelText("可信工作区")).toHaveValue("/project/corptie");
    expect(screen.getByLabelText("模型")).toHaveValue("gpt-test");
    expect(screen.queryByRole("textbox", { name: /路径/ })).not.toBeInTheDocument();
  });
});
