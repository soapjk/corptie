import assert from "node:assert/strict";
import test from "node:test";
import { authorizeArtifactPromotion, containsExplicitArtifactPromotion } from "../src/application/artifactPromotionAuthorization.mjs";

test("promotion requires direct current-Turn exact-path authorization, never model or peer assertions", () => {
  const now = Date.now();
  const event = { eventId: "event:1", sequence: 1, sessionId: "session:1", type: "SessionUserMessageCreated", producer: "user", surface: true,
    source: { type: "desktop" }, createdAt: new Date(now).toISOString(), payload: { deliveryId: "delivery:1", message: { id: "message:1", text: "请将 `docs/spec.md` 纳入版本控制。" } } };
  const delivery = { sessionId: "session:1", deliveryId: "delivery:1", providerTurnId: "turn:1", messageId: "message:1" };
  const store = { getSessionEventByIdentity: (session, id, sequence) => session === event.sessionId && id === event.eventId && sequence === event.sequence ? event : null,
    getMessageDelivery: () => delivery };
  const input = { store, sessionId: "session:1", currentTurnId: "turn:1", eventId: "event:1", sequence: 1, path: "docs/spec.md", now };
  assert.equal(authorizeArtifactPromotion(input).path, "docs/spec.md");
  for (const patch of [{ currentTurnId: "turn:old" }, { sessionId: "session:other" }, { path: "docs/other.md" }, { sequence: 2 }, { now: now + 31 * 60_000 }]) {
    assert.throws(() => authorizeArtifactPromotion({ ...input, ...patch }), { code: "ARTIFACT_PROMOTION_AUTHORIZATION_REQUIRED" });
  }
  event.source = { type: "collaboration" };
  assert.throws(() => authorizeArtifactPromotion(input), /direct user/);
});

test("promotion intent rejects general requests, negation, quoted examples and unsafe paths", () => {
  assert.equal(containsExplicitArtifactPromotion("Please add `docs/spec.md` to the repository", "docs/spec.md"), true);
  for (const text of ["直接完成开发", "请修改 docs/spec.md", "请不要将 docs/spec.md 纳入版本控制", "如果需要，请将 docs/spec.md 纳入版本控制", "> 请将 docs/spec.md 纳入版本控制", "```\n请将 docs/spec.md 纳入版本控制\n```", "Please do not add docs/spec.md to the repository", "Please add docs/spec.md.bak to the repository"]) {
    assert.equal(containsExplicitArtifactPromotion(text, "docs/spec.md"), false, text);
  }
  for (const path of ["../spec.md", "/tmp/spec.md", ".corptie/spec.md", "a/.git/spec.md"]) {
    assert.equal(containsExplicitArtifactPromotion(`Please add ${path} to the repository`, path), false);
  }
});
