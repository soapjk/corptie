export function resolveMessageMentionContext(store, ownerSessionId, mentions = []) {
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  const seen = new Set();
  const targets = [];
  for (const mention of mentions) {
    const key = `${mention.targetType}:${mention.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mention.targetType === "session") {
      if (mention.targetId === ownerSessionId) continue;
      const target = store.getSession(mention.targetId);
      if (!target) continue;
      targets.push({ targetType: "session", targetId: target.id, displayName: target.title });
      continue;
    }
    if (mention.targetType === "work") {
      const target = store.getWork(mention.targetId);
      if (!target) continue;
      targets.push({ targetType: "work", targetId: target.id, displayName: target.name });
    }
  }
  if (targets.length === 0) return null;
  return {
    mentions: targets,
    prompt: [
      "<corptie_message_mentions>",
      "The user explicitly selected these Corptie resources for this message only.",
      "A Session is an exact collaboration target. A Work is context scope, not a message recipient; resolve an appropriate Session before collaborating.",
      JSON.stringify(targets),
      "</corptie_message_mentions>"
    ].join("\n")
  };
}
