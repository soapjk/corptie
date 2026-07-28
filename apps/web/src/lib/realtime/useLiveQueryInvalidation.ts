import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function useLiveQueryInvalidation(eventCursor: number | undefined, queryKeys: QueryKey[]) {
  const queryClient = useQueryClient();
  const serializedKeys = JSON.stringify(queryKeys);

  useEffect(() => {
    if (eventCursor === undefined || typeof EventSource === "undefined") return;
    const stableQueryKeys = JSON.parse(serializedKeys) as QueryKey[];
    const events = new EventSource(`/api/v1/events?cursor=${eventCursor}`);
    let fallback: number | undefined;
    const invalidate = () => {
      for (const queryKey of stableQueryKeys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const resume = () => {
      if (document.visibilityState === "visible") invalidate();
    };
    events.onmessage = invalidate;
    events.onopen = () => {
      if (fallback !== undefined) window.clearInterval(fallback);
      fallback = undefined;
    };
    events.onerror = () => {
      if (fallback === undefined) fallback = window.setInterval(invalidate, 15_000);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", invalidate);
    return () => {
      events.close();
      if (fallback !== undefined) window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", invalidate);
    };
  }, [eventCursor, queryClient, serializedKeys]);
}
