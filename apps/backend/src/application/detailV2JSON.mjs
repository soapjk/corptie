import { canonicalDetailV2, DETAIL_V2_LIMITS } from "./detailSyncV2.mjs";

const fail = () => { throw Object.assign(new Error("DETAIL_V2_JSON"), { code: "DETAIL_V2_JSON", status: 400 }); };
/** Validate raw tokens before JSON.parse can discard duplicate property names.
 * Object keys are printable ASCII in v2. Unicode remains supported in values;
 * ASCII keys avoid Swift Dictionary's Unicode canonical-equivalence aliases. */
export function parseDetailV2JSON(bytes) {
  if (bytes.length > DETAIL_V2_LIMITS.bytes) throw Object.assign(new Error("DETAIL_V2_LIMIT"), { code: "DETAIL_V2_LIMIT", status: 413 });
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail(); }
  let offset = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[offset] ?? "x")) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") { offset += 2; continue; }
      if (source[offset++] === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch { fail(); }
      }
    }
    fail();
  };
  const value = depth => {
    if (depth > DETAIL_V2_LIMITS.depth) fail(); space();
    const token = source[offset];
    if (token === '"') { string(); return; }
    if (token === "{" || token === "[") {
      offset++; space(); const end = token === "{" ? "}" : "]", keys = new Set();
      if (source[offset] === end) { offset++; return; }
      while (offset < source.length) {
        if (token === "{") {
          space(); if (source[offset] !== '"') fail(); const key = string();
          if (!/^[\x20-\x7e]+$/.test(key) || keys.has(key)) fail(); keys.add(key);
          space(); if (source[offset++] !== ":") fail();
        }
        value(depth + 1); space();
        const separator = source[offset++]; if (separator === end) return; if (separator !== ",") fail();
      }
      fail();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!match) fail(); offset += match[0].length;
  };
  value(0); space(); if (offset !== source.length) fail();
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail(); }
  canonicalDetailV2(parsed); // Reject unsafe numeric values and surrogates.
  return parsed;
}

export async function readDetailV2Request(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw Object.assign(new Error("JSON_REQUIRED"), { code: "JSON_REQUIRED", status: 415 });
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw Object.assign(new Error("DETAIL_V2_ENCODING"), { code: "DETAIL_V2_ENCODING", status: 415 });
  }
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  return parseDetailV2JSON(Buffer.concat(chunks));
}
