export function isClearCommand(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "/clear";
}
