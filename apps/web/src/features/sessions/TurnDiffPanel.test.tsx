import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTurnDiff, performTurnAction } from "../../lib/api/client";
import { TurnDiffPanel } from "./TurnDiffPanel";

vi.mock("../../lib/api/client", () => ({
  getTurnDiff: vi.fn(),
  performTurnAction: vi.fn()
}));

describe("TurnDiffPanel", () => {
  afterEach(cleanup);
  it("loads only after explicit expansion and confirms undo", async () => {
    vi.mocked(getTurnDiff).mockResolvedValue({
      apiVersion: "1", eventCursor: 2, sessionId: "codex:one", turnId: "turn",
      files: ["src/app.ts"], diff: "--- a/src/app.ts\n+++ b/src/app.ts"
    });
    vi.mocked(performTurnAction).mockResolvedValue({});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<QueryClientProvider client={new QueryClient()}><TurnDiffPanel sessionId="codex:one" turnId="turn" /></QueryClientProvider>);
    expect(getTurnDiff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("代码差异与本机操作"));
    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销这一轮" }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(performTurnAction).toHaveBeenCalledWith("codex:one", "turn", "undo"));
    confirm.mockRestore();
  });
});
