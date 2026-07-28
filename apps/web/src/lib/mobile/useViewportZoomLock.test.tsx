import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewportZoomLock } from "./useViewportZoomLock";

function Harness() {
  useViewportZoomLock();
  return null;
}

function touchEvent(type: string, touchCount: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: Array.from({ length: touchCount }, () => ({}))
  });
  return event;
}

describe("useViewportZoomLock", () => {
  afterEach(cleanup);

  it("blocks iOS gestures and multi-touch while preserving one-finger scrolling", () => {
    render(<Harness />);

    const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
    document.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(true);

    const pinch = touchEvent("touchmove", 2);
    document.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);

    const scroll = touchEvent("touchmove", 1);
    document.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
  });
});
