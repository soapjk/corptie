import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveQueryInvalidation } from "./useLiveQueryInvalidation";

class FakeEventSource {
  static latest: FakeEventSource;
  onmessage: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }
}

describe("useLiveQueryInvalidation", () => {
  afterEach(cleanup);

  it("resyncs on an SSE event and when the browser returns online", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    expect(FakeEventSource.latest.url).toBe("/api/v1/events?cursor=7");
    act(() => FakeEventSource.latest.onmessage?.());
    act(() => window.dispatchEvent(new Event("online")));
    expect(invalidate).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

function Probe() {
  useLiveQueryInvalidation(7, [["sessions"]]);
  return null;
}
