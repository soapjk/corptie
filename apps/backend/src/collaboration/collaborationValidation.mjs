export function requiredId(value, field) {
  const text = requiredText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw domainError("INVALID_ID", `${field} contains unsupported characters.`);
  }
  return text;
}

export function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw domainError("VALIDATION_ERROR", `${field} is required.`);
  }
  return value.trim();
}

export function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function assertKnownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw domainError("INVALID_INPUT", "Collaboration task input must be an object.");
  }
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw domainError("UNKNOWN_FIELD", `Unknown collaboration task field: ${unknown}.`);
}

export function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
}

export function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw domainError("VALIDATION_ERROR", "maxIterations must be a positive integer.");
  }
  return number;
}


export function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
