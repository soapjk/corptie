// Repository continuations are objects; Detail's internal pager accepts bounded
// strings. These tokens stay on the host, behind the existing scoped UUID.
const invalid = () => Object.assign(new Error("Invalid memory continuation"), { code: "DETAIL_SOURCE_CURSOR_INVALID", status: 500 });
function fields(updatedAt, id) {
  if (typeof updatedAt !== "string" || !updatedAt.length || updatedAt.length > 64
    || !Number.isFinite(Date.parse(updatedAt)) || typeof id !== "string" || !id.trim().length
    || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) throw invalid();
  return { updatedAt, id };
}
export function encodeMemoryContinuation(cursor) {
  if (cursor == null) return null;
  if (typeof cursor !== "object" || Array.isArray(cursor)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(cursor))
    || Object.keys(cursor).length !== 2 || !Object.hasOwn(cursor, "updatedAt") || !Object.hasOwn(cursor, "id")) throw invalid();
  const { updatedAt, id } = fields(cursor.updatedAt, cursor.id);
  const token = Buffer.from(JSON.stringify([1, updatedAt, id]), "utf8").toString("base64url");
  if (token.length > 512) throw invalid();
  return token;
}
export function decodeMemoryContinuation(token) {
  if (token == null) return null;
  if (typeof token !== "string" || !token.length || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  let value;
  try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw invalid(); }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1) throw invalid();
  const cursor = fields(value[1], value[2]);
  if (encodeMemoryContinuation(cursor) !== token) throw invalid();
  return cursor;
}
