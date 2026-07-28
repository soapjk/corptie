import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performSessionAction } from "../../lib/api/client";
import type { SessionDetail } from "../../lib/api/types";
import { SessionComposer } from "./SessionComposer";

vi.mock("../../lib/api/client", () => ({
  performSessionAction: vi.fn()
}));

const session = (id: string): SessionDetail => ({
  id,
  title: id,
  agent: "Codex",
  status: "complete",
  progress: 1,
  summary: "",
  updatedAt: "2026-07-26T12:00:00.000Z",
  createdAt: "2026-07-26T12:00:00.000Z",
  accent: "cyan",
  canSend: true,
  turnCount: 0,
  items: [],
  availableActions: [{ id: "message.send", enabled: true, risk: "low" }]
});

function renderComposer(id: string, onPendingChange = vi.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionComposer session={session(id)} onPendingChange={onPendingChange} />
    </QueryClientProvider>
  );
}

describe("SessionComposer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(performSessionAction).mockReset();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("keeps drafts isolated by session", () => {
    const first = renderComposer("one");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first draft" } });
    first.unmount();
    renderComposer("two");
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second draft" } });
    expect(localStorage.getItem("corptie:web:draft:one")).toBe("first draft");
    expect(localStorage.getItem("corptie:web:draft:two")).toBe("second draft");
  });

  it("restores a failed message and never retries it automatically", async () => {
    const onPendingChange = vi.fn();
    vi.mocked(performSessionAction).mockRejectedValueOnce(new Error("Mac unavailable"));
    renderComposer("one", onPendingChange);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue work" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mac unavailable");
    expect(screen.getByRole("textbox")).toHaveValue("Continue work");
    expect(performSessionAction).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenCalledWith("Continue work");
    expect(onPendingChange).toHaveBeenLastCalledWith(null);
  });

  it("preserves text typed while the previous message is sending", async () => {
    let resolveSend!: (value: never) => void;
    vi.mocked(performSessionAction).mockReturnValue(new Promise((resolve) => {
      resolveSend = resolve;
    }));
    renderComposer("one");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next thought" } });
    resolveSend({} as never);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Next thought"));
  });

  it("keeps the draft editable while a run is active and turns send into stop", async () => {
    vi.mocked(performSessionAction).mockResolvedValue({} as never);
    const running = {
      ...session("running"),
      status: "running" as const,
      canSend: false,
      sendUnavailableReason: "Agent is running",
      availableActions: [
        { id: "message.send", enabled: false, risk: "low" as const },
        { id: "session.interrupt", enabled: true, risk: "medium" as const }
      ]
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionComposer session={running} onPendingChange={vi.fn()} />
      </QueryClientProvider>
    );

    const editor = screen.getByRole("textbox", { name: "给 Agent 发消息" });
    expect(editor).toBeEnabled();
    fireEvent.change(editor, { target: { value: "Agent 完成后继续检查测试" } });
    expect(editor).toHaveValue("Agent 完成后继续检查测试");
    expect(localStorage.getItem("corptie:web:draft:running")).toBe("Agent 完成后继续检查测试");

    fireEvent.click(screen.getByRole("button", { name: "停止当前运行" }));
    await waitFor(() => expect(performSessionAction).toHaveBeenCalledWith(
      "running",
      "session.interrupt",
      {},
      expect.any(String)
    ));
    expect(editor).toHaveValue("Agent 完成后继续检查测试");
  });
});
