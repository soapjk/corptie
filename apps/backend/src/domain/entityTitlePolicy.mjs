// Product titles, not filesystem paths, Provider-native metadata or document bodies.
export const ENTITY_TITLE_RULE = "Chinese characters, English letters, digits, hyphens (-) and underscores (_) only; must not start with a digit; no spaces";

export function isValidEntityTitle(value) {
  return typeof value === "string" && value.length > 0
    && !/[^A-Za-z0-9\p{Script=Han}_-]/u.test(value) && !/^[0-9]/u.test(value);
}

// Only for product-generated defaults. Never silently rewrite user input.
export function generatedEntityTitle(value, fallback = "Session") {
  const raw = String(value ?? "").trim();
  if (!/[A-Za-z0-9\p{Script=Han}_-]/u.test(raw)) return fallback;
  const title = raw.replace(/[^A-Za-z0-9\p{Script=Han}_-]+/gu, "_");
  return /^[0-9]/u.test(title) ? `_${title}` : title;
}
