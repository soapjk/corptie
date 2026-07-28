import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingPage } from "./PairingPage";

describe("Web pairing", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("reads and scrubs the QR hash before requesting Mac approval", async () => {
    window.history.replaceState(null, "", "/pair#code=123456");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: "request-1",
      exchangeToken: "memory-only-token",
      status: "pending",
      expiresAt: "2026-07-26T12:10:00.000Z"
    }), {
      status: 202,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MemoryRouter><PairingPage /></MemoryRouter>);
    expect(screen.getByLabelText("六位配对码")).toHaveValue("123456");
    await waitFor(() => expect(window.location.hash).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "请求配对" }));

    expect(await screen.findByText(/请求已发送/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/pair/requests");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("same-origin");
    expect(fetchMock.mock.calls[0][1].body).toContain('"code":"123456"');
    expect(localStorage.length).toBe(0);
  });
});
