export function isClearCommand(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "/clear";
}

// A leading slash token is a command; absolute paths (/tmp/file) stay text.
export function parseSlashCommand(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), arguments: (match[2] ?? "").trim() } : null;
}
