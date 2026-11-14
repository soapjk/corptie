import { randomInt } from "node:crypto";

// Provider-neutral, versioned display references stored in agents.avatar_path.
// They identify bundled original illustrations, never filesystem paths.
export const BUILTIN_ROLE_AVATAR_PREFIX = "corptie-role-avatar://v1/";
export const BUILTIN_ROLE_AVATAR_IDS = Object.freeze([
  "anime-girl", "ceramic-robot", "elderly-man", "cartoon-dog", "ink-boy", "pixel-robot"
]);
// The earlier 16-entry library may already be persisted. Resolve it to the
// approved library without rewriting records or touching uploaded images.
const legacyIds = new Map(Array.from({ length: 16 }, (_, i) => [
  `robot-${String(i + 1).padStart(2, "0")}`, BUILTIN_ROLE_AVATAR_IDS[i % BUILTIN_ROLE_AVATAR_IDS.length]
]));
export function builtinRoleAvatarId(reference) {
  if (typeof reference !== "string" || !reference.startsWith(BUILTIN_ROLE_AVATAR_PREFIX)) return null;
  const id = reference.slice(BUILTIN_ROLE_AVATAR_PREFIX.length);
  return BUILTIN_ROLE_AVATAR_IDS.includes(id) ? id : legacyIds.get(id) ?? null;
}
export function validateRoleAvatarReference(value) {
  const reference = typeof value === "string" ? value.trim() : "";
  if (reference.startsWith("corptie-role-avatar:") && !builtinRoleAvatarId(reference)) {
    const error = new Error("Unknown built-in role avatar reference.");
    error.code = "INVALID_INPUT";
    error.statusCode = 400;
    throw error;
  }
  return reference || null;
}
export function randomRoleAvatarReference() {
  return BUILTIN_ROLE_AVATAR_PREFIX + BUILTIN_ROLE_AVATAR_IDS[randomInt(BUILTIN_ROLE_AVATAR_IDS.length)];
}
export function defaultRoleAvatarReference(roleId) {
  // FNV-1a over UTF-8 is shared with native clients; no random reads or DB writes.
  let hash = 2166136261;
  for (const byte of Buffer.from(String(roleId), "utf8")) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return BUILTIN_ROLE_AVATAR_PREFIX + BUILTIN_ROLE_AVATAR_IDS[hash % BUILTIN_ROLE_AVATAR_IDS.length];
}
