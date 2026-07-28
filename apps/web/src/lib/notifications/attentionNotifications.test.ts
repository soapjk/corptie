import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../api/types";
import { processAttentionNotifications } from "./attentionNotifications";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "./preferences";

const approval: AttentionItem = {
  id: "attention-secret-id",
  kind: "high-risk-approval",
  priority: 100,
  sessionId: "codex:private",
  sessionTitle: "Secret acquisition",
  agent: "Codex",
  summary: "Approve SECRET_TOKEN=do-not-leak",
  updatedAt: "2026-07-26T12:00:00.000Z",
  actionContext: { command: "rm private.txt" },
  availableActions: []
};

describe("attention notifications", () => {
  beforeEach(() => localStorage.clear());

  it("uses generic content and deduplicates one attention id", () => {
    const notify = vi.fn();
    const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true };
    processAttentionNotifications([approval], preferences, notify);
    processAttentionNotifications([approval], preferences, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(notify.mock.calls[0][0]);
    expect(serialized).not.toContain("Secret acquisition");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("rm private.txt");
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: "Corptie 需要你的注意",
      options: {
        body: "一个 Session 有待处理的确认。",
        tag: "corptie:attention-secret-id"
      }
    });
  });

  it("honors per-device category switches", () => {
    const notify = vi.fn();
    processAttentionNotifications([approval], {
      enabled: true,
      categories: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.categories,
        approval: false
      }
    }, notify);
    expect(notify).not.toHaveBeenCalled();
  });
});
