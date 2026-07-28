import { useEffect, useRef, useState, type CSSProperties } from "react";
import { reloadPwa } from "../lib/pwa/reload";

const TRIGGER_DISTANCE = 96;
const MAX_VISUAL_DISTANCE = 64;

export function PullToRefresh({ onRefresh = reloadPwa }: { onRefresh?: () => void | Promise<void> }) {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const rawDistance = useRef(0);
  const tracking = useRef(false);

  useEffect(() => {
    const isMobile = () => window.matchMedia("(max-width: 599px)").matches;
    const reset = () => {
      tracking.current = false;
      rawDistance.current = 0;
      if (!refreshing) setDistance(0);
    };
    const start = (event: TouchEvent) => {
      if (!isMobile()
        || window.scrollY > 0
        || event.touches.length !== 1
        || isEditingTarget(event.target)) {
        reset();
        return;
      }
      tracking.current = true;
      startY.current = event.touches[0].clientY;
      rawDistance.current = 0;
    };
    const move = (event: TouchEvent) => {
      if (!tracking.current || event.touches.length !== 1) return;
      const next = event.touches[0].clientY - startY.current;
      if (next <= 0) {
        rawDistance.current = 0;
        setDistance(0);
        return;
      }
      event.preventDefault();
      rawDistance.current = next;
      setDistance(Math.min(MAX_VISUAL_DISTANCE, next * 0.5));
    };
    const end = () => {
      if (!tracking.current) return;
      const shouldRefresh = rawDistance.current >= TRIGGER_DISTANCE;
      tracking.current = false;
      rawDistance.current = 0;
      if (!shouldRefresh) {
        setDistance(0);
        return;
      }
      setRefreshing(true);
      setDistance(48);
      void onRefresh();
    };

    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", reset);
    };
  }, [onRefresh, refreshing]);

  const ready = rawDistance.current >= TRIGGER_DISTANCE;
  return (
    <div
      aria-live="polite"
      className={`pull-to-refresh ${distance ? "is-visible" : ""} ${ready ? "is-ready" : ""}`}
      style={{ "--pull-distance": `${distance}px` } as CSSProperties}
    >
      <span aria-hidden="true">{refreshing ? "↻" : "↓"}</span>
      <strong>{refreshing ? "正在刷新…" : ready ? "松开刷新" : "下拉刷新"}</strong>
    </div>
  );
}

function isEditingTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
