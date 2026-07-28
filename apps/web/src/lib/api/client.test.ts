import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiRequest,
  claimPairing,
  getBootstrap,
  getSessions,
  resetApiSessionForTests
} from "./client";

describe("Corptie API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiSessionForTests();
    localStorage.clear();
  });

  it("uses same-origin credentials and forwards bootstrap CSRF to mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        apiVersion: "1",
        environment: "development",
        serverTime: "2026-07-26T12:00:00.000Z",
        eventCursor: 2,
        csrfToken: "csrf-token",
        device: {
          id: "device-1",
          name: "Phone",
          permission: "full-control",
          createdAt: "2026-07-26T12:00:00.000Z"
        },
        features: {},
        preferences: {}
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await getBootstrap();
    await apiRequest("/sessions/codex%3A1/actions", {
      method: "POST",
      idempotencyKey: "once",
      body: JSON.stringify({ action: "session.interrupt", payload: {} })
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/bootstrap");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("same-origin");
    const headers = fetchMock.mock.calls[1][1].headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
    expect(headers.get("idempotency-key")).toBe("once");
  });

  it("uses a sanitized snapshot only for an offline network failure", async () => {
    localStorage.setItem("corptie:web:snapshot:sessions:v1", JSON.stringify({
      savedAt: "2026-07-26T12:00:00.000Z",
      response: { apiVersion: "1", eventCursor: 4, sessions: [] }
    }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await getSessions()).toEqual({ apiVersion: "1", eventCursor: 4, sessions: [] });
  });

  it("automatically bootstraps CSRF before a direct mutation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrfToken: "fresh-csrf"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/sessions/codex%3A1/actions", {
      method: "POST",
      body: JSON.stringify({ action: "turn.start", payload: { prompt: "hello" } })
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/bootstrap");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/sessions/codex%3A1/actions");
    const headers = fetchMock.mock.calls[1][1].headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("fresh-csrf");
  });

  it("uses the CSRF token returned by pairing without another bootstrap", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "approved",
        expiresAt: "2026-07-26T12:10:00.000Z",
        csrfToken: "paired-csrf",
        device: {
          id: "device-1",
          name: "Phone",
          permission: "reply"
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await claimPairing("request-1", "exchange-1");
    await apiRequest("/sessions/codex%3A1/actions", {
      method: "POST",
      body: JSON.stringify({ action: "turn.start", payload: { prompt: "hello" } })
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/pair/requests/request-1/claim");
    const headers = fetchMock.mock.calls[1][1].headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("paired-csrf");
  });
});
