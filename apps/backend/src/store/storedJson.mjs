import { logError } from "../utils/errorDiagnostics.mjs";
export function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    // JSON parser messages can quote stored user content; retain the category only.
    if (typeof value === "string" && value.trim()) logError("store.json-decode", {
      name: error.name, message: "Stored JSON decoding failed.",
      stack: new Error("Stored JSON decoding failed.").stack
    }, { stage: "decode-stored-json" });
    return fallback;
  }
}
