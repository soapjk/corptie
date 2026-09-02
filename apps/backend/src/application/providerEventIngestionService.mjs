import { createHash } from "node:crypto";

export const PROVIDER_EVENT_TYPES = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "user.message.accepted",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "provider.error",
  "provider.connection.changed"
]);

export class ProviderEventIngestionService {
  constructor({ store, resolveBinding, project, onCommitted = () => {}, observe = () => null }) {
    if (!store?.runInTransaction || !store?.insertProviderInboxEvent) {
      throw new Error("ProviderEventIngestionService requires a transactional Provider event Store.");
    }
    if (typeof resolveBinding !== "function") {
      throw new Error("ProviderEventIngestionService requires a Binding resolver.");
    }
    if (typeof project !== "function") {
      throw new Error("ProviderEventIngestionService requires a projection function.");
    }
    this.store = store;
    this.resolveBinding = resolveBinding;
    this.project = project;
    this.onCommitted = onCommitted;
    this.observe = observe;
  }

  ingest(input) {
    const projectionStartedAtMs = performance.timeOrigin + performance.now();
    const event = normalizeProviderEvent(input);
    const binding = this.resolveBinding(event);
    if (!binding) {
      return this.quarantine(event, "PROVIDER_BINDING_NOT_FOUND", "Provider event Binding is not registered.");
    }
    const bindingError = validateBinding(event, binding);
    if (bindingError) {
      return this.quarantine(event, bindingError.code, bindingError.message, binding.sessionId ?? null);
    }

    const existing = this.store.providerInboxEvent(
      event.providerId,
      event.providerSessionId,
      event.providerEventId
    );
    if (existing) return duplicateResult(this.store, event, existing);

    const cursor = this.store.providerBindingCursor(event.bindingId);
    const sequenceDecision = providerSequenceDecision(cursor, event.providerSequence);
    if (sequenceDecision.kind === "stale") {
      return this.quarantine(
        event,
        "PROVIDER_SEQUENCE_STALE",
        `Provider sequence ${event.providerSequence} is not newer than ${cursor.last_provider_sequence}.`,
        binding.sessionId
      );
    }
    if (sequenceDecision.kind === "gap") {
      return this.quarantineGap(event, binding, sequenceDecision);
    }

    let committedOutbox = [];
    const result = this.store.runInTransaction(() => {
      const inserted = this.store.insertProviderInboxEvent(
        event,
        binding.sessionId,
        providerEventFingerprint(event)
      );
      if (!inserted) return duplicateResult(this.store, event);

      const projection = this.project({ event, binding, store: this.store }) ?? {};
      const sessionEvent = this.store.appendSessionEvent({
        eventId: domainEventId(event),
        sessionId: binding.sessionId,
        type: event.type,
        source: {
          type: "provider",
          providerId: event.providerId,
          providerSessionId: event.providerSessionId,
          bindingId: event.bindingId,
          routingVersion: event.routingVersion
        },
        payload: {
          ...durableSessionEventPayload(event),
          ...(event.type === "turn.completed"
            ? { hasAgentMessage: projection.hasAgentMessage === true }
            : {}),
          providerEventId: event.providerEventId,
          providerSequence: event.providerSequence ?? null,
          turnId: event.turnId ?? null,
          itemId: event.itemId ?? null
        },
        createdAt: event.occurredAt ?? event.receivedAt,
        surface: projection.surface ?? false,
        storageVersion: 2
      });
      this.store.upsertProviderBindingCursor(event, {
        syncHealth: "healthy",
        connectionStatus: providerConnectionStatus(event),
        resumeToken: event.resumeToken ?? null
      });
      this.store.markProviderInboxEvent(event.providerId, event.providerSessionId, event.providerEventId, {
        status: "applied",
        appliedAt: event.receivedAt
      });

      const outboxPayloads = [{
        topic: "provider-events",
        eventType: event.type,
        payload: { event, sessionEvent }
      }, ...(projection.outbox ?? [])];
      committedOutbox = outboxPayloads.map((entry, index) => this.store.enqueueEventOutbox({
        outboxId: `${domainEventId(event)}:outbox:${index}`,
        topic: entry.topic,
        sessionId: binding.sessionId,
        revision: entry.revision ?? null,
        eventType: entry.eventType ?? event.type,
        payload: entry.payload ?? { event, sessionEvent },
        createdAt: event.receivedAt
      }));
      return { status: "applied", event, sessionEvent, projection, outbox: committedOutbox };
    });

    if (result.status === "applied") {
      this.onCommitted(committedOutbox);
      try {
        result.observability = this.observe({
          event,
          binding,
          sessionEvent: result.sessionEvent,
          projection: result.projection,
          measurement: { projectionStartedAtMs, projectionEndedAtMs: performance.timeOrigin + performance.now() }
        });
      } catch (error) {
        result.observabilityError = { code: error.code ?? "TURN_OBSERVABILITY_FAILED", message: error.message };
      }
    }
    return result;
  }

  quarantine(event, code, message, sessionId = null) {
    return this.store.runInTransaction(() => {
      const inserted = this.store.insertProviderInboxEvent(
        event,
        sessionId,
        providerEventFingerprint(event)
      );
      if (!inserted) return duplicateResult(this.store, event);
      this.store.markProviderInboxEvent(event.providerId, event.providerSessionId, event.providerEventId, {
        status: "quarantined",
        failureCode: code,
        failureMessage: message
      });
      return { status: "quarantined", code, message, event };
    });
  }

  quarantineGap(event, binding, decision) {
    return this.store.runInTransaction(() => {
      const inserted = this.store.insertProviderInboxEvent(
        event,
        binding.sessionId,
        providerEventFingerprint(event)
      );
      if (!inserted) return duplicateResult(this.store, event);
      this.store.markProviderInboxEvent(event.providerId, event.providerSessionId, event.providerEventId, {
        status: "quarantined",
        failureCode: "PROVIDER_SEQUENCE_GAP",
        failureMessage: `Expected Provider sequence ${decision.expected} but received ${decision.received}.`
      });
      this.store.upsertProviderBindingCursor(event, {
        syncHealth: "gap",
        gapExpectedSequence: decision.expected,
        gapReceivedSequence: decision.received,
        cursorSequence: decision.previous,
        cursorEventId: null
      });
      return {
        status: "quarantined",
        code: "PROVIDER_SEQUENCE_GAP",
        expectedSequence: decision.expected,
        receivedSequence: decision.received,
        event
      };
    });
  }
}

const PROJECTED_ITEM_EVENT_TYPES = new Set([
  "user.message.accepted",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved"
]);

const TERMINAL_TURN_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled"
]);

export function durableSessionEventPayload(event) {
  const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? { ...event.payload }
    : {};
  if (PROJECTED_ITEM_EVENT_TYPES.has(event.type) && payload.item) {
    payload.itemReference = providerItemReference(payload.item);
    delete payload.item;
  }
  if (TERMINAL_TURN_EVENT_TYPES.has(event.type) && Array.isArray(payload.items)) {
    payload.itemReferences = payload.items.map(providerItemReference).filter(Boolean);
    delete payload.items;
  }
  return payload;
}

function providerItemReference(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const content = stableJson(item);
  const summary = compactText(item.summary ?? item.text ?? item.title);
  return {
    id: optionalText(item.id),
    type: optionalText(item.type),
    turnId: optionalText(item.turnId),
    status: optionalText(item.status),
    presentationRole: optionalText(item.presentationRole),
    ...(summary ? { summary } : {}),
    contentHash: createHash("sha256").update(content).digest("hex")
  };
}

function compactText(value, maximumLength = 4096) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length <= maximumLength
    ? text
    : `${text.slice(0, maximumLength)}\n[truncated; full content is stored in the Session Item projection]`;
}

function providerConnectionStatus(event) {
  if (event.type === "provider.error") {
    return event.payload?.willRetry ? "reconnecting" : "disconnected";
  }
  if (event.type !== "provider.connection.changed") return "connected";
  const raw = String(
    event.payload?.connectionStatus
      ?? event.payload?.status
      ?? event.rawPayload?.connectionStatus
      ?? event.rawPayload?.connection_status
      ?? event.rawPayload?.status
      ?? "connected"
  ).toLowerCase();
  if (raw.includes("reconnect") || raw.includes("connecting")) return "reconnecting";
  if (raw.includes("disconnect") || raw.includes("closed") || raw.includes("offline")) return "disconnected";
  return "connected";
}

export function normalizeProviderEvent(input, now = () => new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw providerEventError("PROVIDER_EVENT_INVALID", "Provider event must be an object.");
  }
  const event = {
    schemaVersion: Number(input.schemaVersion ?? 1),
    providerId: requiredText(input.providerId, "providerId"),
    providerSessionId: requiredText(input.providerSessionId, "providerSessionId"),
    bindingId: requiredText(input.bindingId, "bindingId"),
    logicalSessionId: optionalText(input.logicalSessionId),
    routingVersion: Number(input.routingVersion),
    providerEventId: optionalText(input.providerEventId),
    providerSequence: optionalSequence(input.providerSequence),
    resumeToken: optionalText(input.resumeToken),
    turnId: optionalText(input.turnId),
    itemId: optionalText(input.itemId),
    type: requiredText(input.type, "type"),
    occurredAt: optionalText(input.occurredAt),
    receivedAt: optionalText(input.receivedAt) ?? now(),
    payload: normalizedPayload(input.payload),
    rawPayload: input.rawPayload ?? input.payload ?? {}
  };
  if (event.schemaVersion !== 1) {
    throw providerEventError("PROVIDER_EVENT_SCHEMA_UNSUPPORTED", `Unsupported Provider event schema ${event.schemaVersion}.`);
  }
  if (!Number.isSafeInteger(event.routingVersion) || event.routingVersion < 1) {
    throw providerEventError("PROVIDER_EVENT_ROUTING_VERSION_INVALID", "routingVersion must be a positive integer.");
  }
  if (!PROVIDER_EVENT_TYPES.has(event.type)) {
    throw providerEventError("PROVIDER_EVENT_TYPE_UNSUPPORTED", `Unsupported Provider event type: ${event.type}`);
  }
  event.providerEventId ??= deterministicProviderEventId(event);
  return event;
}

export function deterministicProviderEventId(event) {
  // Some Providers expose lifecycle notifications without a native event ID
  // or sequence. The normalized product event type alone is not enough to
  // identify those notifications: for example Codex item/started and
  // item/completed both project to user.message.accepted. Preserve the stable
  // native phase in the generated identity so reconnect replays stay
  // idempotent without collapsing two different physical events.
  const nativeEventDiscriminator = optionalText(
    event.payload?.nativeMethod ?? event.payload?.nativeType
  );
  const needsPayloadDiscriminator = event.providerSequence == null && [
    "assistant.message.delta",
    "tool.progress",
    "usage.updated",
    "provider.error",
    "provider.connection.changed"
  ].includes(event.type);
  const identity = stableJson({
    bindingId: event.bindingId,
    routingVersion: event.routingVersion,
    providerSequence: event.providerSequence ?? null,
    turnId: event.turnId ?? null,
    itemId: event.itemId ?? null,
    type: event.type,
    nativeEventDiscriminator,
    ...(needsPayloadDiscriminator ? { payload: event.payload ?? {} } : {})
  });
  return `generated:${createHash("sha256").update(identity).digest("hex")}`;
}

function validateBinding(event, binding) {
  if (binding.isCurrentRoute === false) {
    return providerEventError(
      "PROVIDER_BINDING_GENERATION_STALE",
      "Provider event belongs to a superseded Binding generation."
    );
  }
  if (binding.bindingId !== event.bindingId) {
    return providerEventError("PROVIDER_BINDING_MISMATCH", "Provider event resolved to a different Binding.");
  }
  if (binding.providerId !== event.providerId || binding.providerSessionId !== event.providerSessionId) {
    return providerEventError("PROVIDER_SESSION_MISMATCH", "Provider event does not match the Binding transport identity.");
  }
  if (Number(binding.routingVersion) !== event.routingVersion) {
    return providerEventError("PROVIDER_ROUTING_VERSION_STALE", "Provider event routingVersion does not match its Binding.");
  }
  if (event.logicalSessionId && binding.logicalSessionId !== event.logicalSessionId) {
    return providerEventError("PROVIDER_LOGICAL_SESSION_MISMATCH", "Provider event logical Session does not match its Binding.");
  }
  return null;
}

function providerSequenceDecision(cursor, incoming) {
  if (incoming == null || cursor?.last_provider_sequence == null) return { kind: "next" };
  const previous = Number(cursor.last_provider_sequence);
  if (incoming <= previous) return { kind: "stale", previous };
  if (incoming !== previous + 1) {
    return { kind: "gap", previous, expected: previous + 1, received: incoming };
  }
  return { kind: "next", previous };
}

function duplicateResult(store, event, knownExisting = null) {
  const existing = knownExisting
    ?? store.providerInboxEvent(event.providerId, event.providerSessionId, event.providerEventId);
  const fingerprint = providerEventFingerprint(event);
  if (existing?.event_fingerprint) {
    if (existing.event_fingerprint !== fingerprint) {
      throw providerEventError(
        "PROVIDER_EVENT_ID_CONFLICT",
        "Provider event ID was reused with different normalized content."
      );
    }
    return { status: "duplicate", event };
  }
  const existingEvent = parseJsonObject(existing?.normalized_event_json);
  if (!existingEvent || providerEventFingerprint(existingEvent) !== fingerprint) {
    throw providerEventError(
      "PROVIDER_EVENT_ID_CONFLICT",
      "Provider event ID was reused with different normalized content."
    );
  }
  return { status: "duplicate", event };
}

export function providerEventFingerprint(event) {
  return createHash("sha256").update(stableJson({
    schemaVersion: event.schemaVersion,
    providerId: event.providerId,
    providerSessionId: event.providerSessionId,
    bindingId: event.bindingId,
    logicalSessionId: event.logicalSessionId ?? null,
    routingVersion: event.routingVersion,
    providerEventId: event.providerEventId,
    providerSequence: event.providerSequence ?? null,
    turnId: event.turnId ?? null,
    itemId: event.itemId ?? null,
    type: event.type,
    occurredAt: event.occurredAt ?? null,
    payload: event.payload ?? {}
  })).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function domainEventId(event) {
  return `provider:${event.providerId}:${event.providerSessionId}:${event.providerEventId}`;
}

function requiredText(value, field) {
  const normalized = optionalText(value);
  if (!normalized) throw providerEventError("PROVIDER_EVENT_FIELD_REQUIRED", `${field} is required.`);
  return normalized;
}

function optionalText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function optionalSequence(value) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw providerEventError("PROVIDER_EVENT_SEQUENCE_INVALID", "providerSequence must be a non-negative integer.");
  }
  return normalized;
}

function normalizedPayload(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw providerEventError("PROVIDER_EVENT_PAYLOAD_INVALID", "Provider event payload must be an object.");
  }
  return structuredClone(value);
}

function providerEventError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
