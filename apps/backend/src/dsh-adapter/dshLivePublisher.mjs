import { randomUUID } from "node:crypto";
import { mapEvent as mapDshEvent } from "./dshEventMapper.mjs";

// One adapter instance owns live turns and synthetic sequence cursors.
// Persistent Session events remain the source for replay.
export function createDshLivePublisher({
  lastSessionEventSequence, broadcastDshMuxFrame, broadcastDshHostFrame
}) {
  const dshLiveTurns = new Map();
  const dshLiveSequenceBySession = new Map();

  function dshLiveEvents(sessionEvent) {
    const sourceSeq = Number(sessionEvent?.sequence ?? 0);

    if (sessionEvent?.type === "user/message") {
      if (dshLiveTurns.has(sessionEvent?.sessionId)) return [];
      const mapped = mapDshEvent(sessionEvent);
      if (!mapped) return [];
      return [{ ...mapped, seq: sourceSeq }];
    }

    if (sessionEvent?.type === "assistant/message") {
      const mapped = mapDshEvent(sessionEvent);
      if (!mapped) return [];
      const live = dshLiveTurns.get(sessionEvent?.sessionId);
      if (live) {
        let seq = live.nextSeq;
        const time = Date.parse(sessionEvent?.createdAt ?? "") || Date.now();
        const message = mapped.data?.message;
        const events = [
          { ...mapped, seq: seq++, time, data: { turn: live.turn, step: 0, message } },
          { type: "step/end", seq: seq++, time, data: { turn: live.turn, step: 0 } },
          { type: "turn/end", seq: seq++, time, data: { turn: live.turn, reason: { kind: "completed" } } },
        ];
        dshLiveTurns.delete(sessionEvent.sessionId);
        dshLiveSequenceBySession.set(sessionEvent.sessionId, seq - 1);
        return events;
      }
      return [{ ...mapped, seq: sourceSeq }];
    }

    return [];
  }

  function publishDshPromptStart(sessionId, text) {
    const storedTail = lastSessionEventSequence(sessionId);
    let seq = Math.max(storedTail, dshLiveSequenceBySession.get(sessionId) ?? storedTail) + 1;
    const turn = seq;
    const time = Date.now();
    const events = [
      { type: "turn/start", seq: seq++, time, data: { turn } },
      {
        type: "user/message",
        seq: seq++,
        time,
        surfaceOp: "append",
        data: {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        },
      },
      { type: "step/start", seq: seq++, time, data: { turn, step: 0 } },
    ];
    dshLiveTurns.set(sessionId, { turn, nextSeq: seq });
    dshLiveSequenceBySession.set(sessionId, seq - 1);
    for (const event of events) {
      broadcastDshMuxFrame({ type: "session/event", sessionId, event });
    }
    broadcastDshHostFrame({ type: "host/session-status", sessionId, running: true });
  }

  function publishDshPromptFailure(sessionId, message) {
    const live = dshLiveTurns.get(sessionId);
    if (!live) return;
    let seq = live.nextSeq;
    const time = Date.now();
    const events = [
      { type: "step/end", seq: seq++, time, data: { turn: live.turn, step: 0 } },
      { type: "turn/end", seq: seq++, time, data: { turn: live.turn, reason: { kind: "error", message } } },
    ];
    dshLiveTurns.delete(sessionId);
    dshLiveSequenceBySession.set(sessionId, seq - 1);
    for (const event of events) {
      broadcastDshMuxFrame({ type: "session/event", sessionId, event });
    }
    broadcastDshHostFrame({ type: "host/session-status", sessionId, running: false });
  }

  function dshRunningStatusForEvent(type) {
    switch (type) {
      case "SessionRunStarted":
      case "AgentWorkStarted":
        return true;
      case "SessionRunInterrupted":
      case "AgentWorkCompleted":
      case "AgentWorkFailed":
      case "CodexThreadCompleted":
      case "CodexThreadCancelled":
      case "CodexThreadFailed":
        return false;
      default:
        return null;
    }
  }

  function publishSessionEvent(sessionEvent) {
    const sessionId = sessionEvent.sessionId;
    for (const event of dshLiveEvents(sessionEvent)) {
      broadcastDshMuxFrame({ type: "session/event", sessionId, event });
    }
    const running = dshRunningStatusForEvent(sessionEvent.type);
    if (running !== null) {
      broadcastDshHostFrame({ type: "host/session-status", sessionId, running });
    }
  }

  return {
    publishSessionEvent, publishDshPromptStart, publishDshPromptFailure,
    get activeTurnCount() { return dshLiveTurns.size; }
  };
}
