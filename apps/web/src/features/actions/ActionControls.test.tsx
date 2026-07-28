import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performSessionAction } from "../../lib/api/client";
import { ActionControls } from "./ActionControls";

vi.mock("../../lib/api/client", () => ({
  performSessionAction: vi.fn(),
  getOperation: vi.fn()
}));

describe("ActionControls", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(performSessionAction).mockReset();
    vi.mocked(performSessionAction).mockResolvedValue({
      apiVersion: "1",
      operationId: "op-1",
      status: "succeeded",
      accepted: true,
      sessionRevision: 3,
      result: {}
    });
  });

  it("requires a second confirmation before high-risk approval", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(performSessionAction).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("reuses the same idempotency key for a repeated action", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByRole("status")).toHaveTextContent("操作已完成");
    const firstKey = vi.mocked(performSessionAction).mock.calls[0][3];
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByRole("status")).toHaveTextContent("操作已完成");
    expect(vi.mocked(performSessionAction).mock.calls[1][3]).toBe(firstKey);
    confirm.mockRestore();
  });
});

function renderControls() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ActionControls itemId="approval-1" mode="approval" sessionId="codex:one" />
    </QueryClientProvider>
  );
}
