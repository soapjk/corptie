import { directUserTaskCreationRejection } from "./directUserTaskCreationAuthorization.mjs";

const deny = (message) => Object.assign(new Error(message), { code: "ARTIFACT_PROMOTION_AUTHORIZATION_REQUIRED", statusCode: 403 });

export function authorizeArtifactPromotion({ store, sessionId, currentTurnId, eventId, sequence, path, now = Date.now() }) {
  if (!sessionId || !currentTurnId || !eventId || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw deny("Runtime-bound current Session/Turn and exact direct-user event evidence are required.");
  }
  const event = store.getSessionEventByIdentity(sessionId, eventId, sequence);
  if (directUserTaskCreationRejection(event)) throw deny("Only a persisted direct user message can authorize promotion.");
  const delivery = store.getMessageDelivery(event.payload?.deliveryId);
  if (!delivery || delivery.sessionId !== sessionId || delivery.messageId !== event.payload?.message?.id
    || ![delivery.deliveryId, delivery.providerTurnId].filter(Boolean).includes(currentTurnId)) {
    throw deny("Promotion evidence must belong to the authenticated current Turn.");
  }
  const age = now - Date.parse(event.createdAt);
  if (!Number.isFinite(age) || age < -5000 || age > 30 * 60_000) throw deny("Direct-user promotion evidence has expired.");
  if (!containsExplicitArtifactPromotion(event.payload?.message?.text, path)) {
    throw deny("The direct user must explicitly authorize version control for this exact document path.");
  }
  return { sessionId, turnId: currentTurnId, eventId: event.eventId, sequence: event.sequence, path };
}

export function containsExplicitArtifactPromotion(text, path) {
  if (typeof path !== "string" || !/\.md$/i.test(path) || path.startsWith("/") || path.includes("\\")
    || path.split("/").some(part => !part || part === "." || part === ".." || [".git", ".corptie"].includes(part.toLowerCase()))
    || /[\s`"'<>]/u.test(path)) return false;
  const message = String(text ?? "");
  // Conservative fallback for natural-language evidence: quoted examples,
  // hypothetical/negative permission and broad requests are never grants.
  if (/(?:不要|禁止|不允许|不许|不能|不可|暂不|别把|如果|除非)|\b(?:not|never|unless|if|example|quote)\b/iu.test(message)) return false;
  const prose = message.replace(/```[\s\S]*?```/gu, "").split(/\r?\n/u).filter(line => !/^\s*>/u.test(line));
  return prose.some(line => {
    const paths = line.split(/[\s`"'<>，。；！？,;!?]+/u);
    if (!paths.includes(path)) return false;
    return /(?:请|允许|授权|同意|直接).{0,100}(?:纳入版本控制|加入版本控制|纳入仓库|写入仓库|提交到仓库)/u.test(line)
      || /\b(?:please|authorize|allow|approve)\b.{0,150}\b(?:track|version.control|promote|add.{0,60}(?:repository|repo|git))\b/iu.test(line);
  });
}
