import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceSettingsPage } from "./DeviceSettingsPage";

describe("device notification settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: vi.fn()
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps core functionality available when browser notification permission is denied", () => {
    render(<DeviceSettingsPage />);
    expect(screen.getByRole("button", { name: "重新载入" })).toBeInTheDocument();
    expect(screen.getByText(/核心开发功能仍可正常使用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请求授权" })).toBeDisabled();
  });

  it("stores category choices only on the current device", () => {
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn()
    });
    render(<DeviceSettingsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /已关闭/ }));
    const completed = screen.getByRole("checkbox", { name: /任务完成/ });
    fireEvent.click(completed);
    expect(localStorage.getItem("corptie:web:notification-preferences:v1")).toContain('"completed":false');
  });
});
