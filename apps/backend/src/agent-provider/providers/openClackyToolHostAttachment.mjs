// Provider-specific shape of the Tool Host attachment for OpenClacky. The bridge
// exposes a single `corptie_call` tool that forwards invocations to the
// Provider-neutral Tool Host. This is a protocol adapter only; it never reimplements
// Work / Memory / Skill / Workspace logic and never mutates the user's native
// OpenClacky configuration.
export function openClackyToolHostAttachment(attachment, providerOptions = {}) {
  if (!attachment?.actorId || !Array.isArray(attachment?.tools)) {
    throw new TypeError("OpenClacky Tool Host attachment requires an actor id and tool catalog.");
  }
  return {
    kind: "corptie_call",
    actorId: attachment.actorId,
    metadata: attachment.metadata ?? null,
    tools: attachment.tools.map((tool) => ({ ...tool })),
    ...providerOptions
  };
}
