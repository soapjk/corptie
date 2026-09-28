export function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

export function optionalStoredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function storeDomainError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
