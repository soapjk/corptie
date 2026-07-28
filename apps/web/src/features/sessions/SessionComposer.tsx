import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { performSessionAction } from "../../lib/api/client";
import type { ApprovalOption, SessionDetail } from "../../lib/api/types";

const DRAFT_PREFIX = "corptie:web:draft:";

export function SessionComposer({
  session,
  onPendingChange
}: {
  session: SessionDetail;
  onPendingChange: (text: string | null) => void;
}) {
  const storageKey = `${DRAFT_PREFIX}${session.id}`;
  const [draft, setDraftState] = useState(() => readDraft(storageKey));
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const sendAction = session.availableActions.find((action) => action.id === "message.send");
  const interruptAction = session.availableActions.find((action) => action.id === "session.interrupt");
  const canSend = session.canSend !== false && sendAction?.enabled === true;
  const canInterrupt = interruptAction?.enabled === true;
  const canCompose = canSend || canInterrupt;
  const options = useMemo(() => latestOptions(session), [session]);

  useEffect(() => {
    setDraftState(readDraft(storageKey));
    setError("");
  }, [storageKey]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const mutation = useMutation({
    retry: false,
    mutationFn: async ({ text, option }: { text: string; option?: ApprovalOption }) => {
      if (!navigator.onLine) throw new Error("当前离线。消息保留在草稿中，不会自动重发。");
      const idempotencyKey = createIdempotencyKey();
      if (option) {
        return performSessionAction(session.id, "choice.respond", {
          optionId: option.id,
          optionIndex: option.index,
          approved: option.role === "approve"
        }, idempotencyKey);
      }
      return performSessionAction(session.id, "message.send", { text }, idempotencyKey);
    },
    onMutate: ({ text, option }) => {
      setError("");
      onPendingChange(option?.label ?? text);
      if (!option) setDraft("");
    },
    onSuccess: () => {
      onPendingChange(null);
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause, variables) => {
      onPendingChange(null);
      const message = cause instanceof Error ? cause.message : "发送失败，请重试。";
      setError(message);
      if (!variables.option) {
        setDraftState((current) => {
          const recovered = current.trim() ? `${variables.text}\n${current}` : variables.text;
          writeDraft(storageKey, recovered);
          return recovered;
        });
      }
    }
  });
  const interruptMutation = useMutation({
    retry: false,
    mutationFn: () => {
      if (!navigator.onLine) throw new Error("当前离线，无法停止运行。");
      return performSessionAction(session.id, "session.interrupt", {}, createIdempotencyKey());
    },
    onMutate: () => setError(""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "停止失败，请重试。");
    }
  });

  function setDraft(value: string) {
    setDraftState(value);
    writeDraft(storageKey, value);
  }

  function submit() {
    const text = draft.trim();
    if (!text || mutation.isPending || !canSend) return;
    mutation.mutate({ text });
  }

  return (
    <section className="surface session-composer" aria-label="消息输入">
      {options.length ? (
        <div className="quick-options" aria-label="快捷选择">
          {options.map((option) => (
            <button
              disabled={mutation.isPending || !online || !canSend}
              key={option.id}
              onClick={() => mutation.mutate({ text: option.label, option })}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        <textarea
          aria-label="给 Agent 发消息"
          disabled={!canCompose}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (canSend && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={canCompose ? "继续交代任务…" : (session.sendUnavailableReason ?? "当前无法发送")}
          rows={1}
          value={draft}
        />
        <button
          aria-label={canInterrupt ? "停止当前运行" : "发送"}
          className={`composer-send ${canInterrupt ? "is-stop" : ""}`}
          disabled={canInterrupt
            ? interruptMutation.isPending || !online
            : !draft.trim() || mutation.isPending || !canSend || !online}
          onClick={() => canInterrupt ? interruptMutation.mutate() : submit()}
          type="button"
        >
          {canInterrupt
            ? (interruptMutation.isPending ? "停止中" : "停止")
            : (mutation.isPending ? "发送中" : "发送")}
        </button>
      </div>
      {!online ? <p className="composer-notice">当前离线，草稿不会自动发送。</p> : null}
      {error ? <p className="composer-error" role="alert">{error}</p> : null}
    </section>
  );
}

function latestOptions(session: SessionDetail) {
  if (session.suggestedOptions?.length) return session.suggestedOptions;
  return [...session.items].reverse().find((item) => item.options?.length)?.options ?? [];
}

function readDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private browsing or a full quota must not block composing.
  }
}

function createIdempotencyKey() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
