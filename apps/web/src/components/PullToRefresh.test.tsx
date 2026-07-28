import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "./PullToRefresh";

function touch(type: string, clientY?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: clientY === undefined ? [] : [{ clientY }]
  });
  return event;
}

describe("PullToRefresh", () => {
  afterEach(cleanup);
  beforeEach(() => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
  });

  it("refreshes after a deliberate top-edge pull", () => {
    const refresh = vi.fn();
    render(<PullToRefresh onRefresh={refresh} />);

    act(() => {
      document.dispatchEvent(touch("touchstart", 20));
      const move = touch("touchmove", 130);
      document.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
    });
    expect(screen.getByText("松开刷新")).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(touch("touchend"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在刷新…")).toBeInTheDocument();
  });
});
