import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performSessionAction } from "../../lib/api/client";
import type { SessionDetail } from "../../lib/api/types";
import { SessionControls } from "./SessionControls";

vi.mock("../../lib/api/client", () => ({
  performSessionAction: vi.fn()
}));

const base: SessionDetail = {
  id: "codex:one",
  title: "Control me",
  agent: "Codex",
  status: "running",
  progress: 0.5,
  summary: "",
  updatedAt: "2026-07-26T12:00:00.000Z",
  createdAt: "2026-07-26T12:00:00.000Z",
  accent: "cyan",
  turnCount: 0,
  items: [],
  availableActions: [
    { id: "session.interrupt", enabled: true, risk: "medium" },
    { id: "session.reconnect", enabled: false, risk: "low", reason: "Already connected" },
    { id: "session.model.set", enabled: true, risk: "medium" }
  ]
};

describe("SessionControls", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(performSessionAction).mockResolvedValue({
      apiVersion: "1",
      operationId: "op",
      status: "succeeded",
      accepted: true,
      sessionRevision: 2,
      result: {}
    });
  });

  it("drives button availability entirely from availableActions", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionControls session={base} />
      </QueryClientProvider>
    );
    expect(screen.getByRole("button", { name: "中断运行" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "重新连接" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "中断运行" }));
    await waitFor(() => expect(performSessionAction).toHaveBeenCalledWith(
        "codex:one",
        "session.interrupt",
        {},
        expect.stringContaining("session-control:codex:one:session.interrupt")
      ));
  });
});
