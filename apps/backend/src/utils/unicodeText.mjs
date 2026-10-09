const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** UTF-16 budget, but never split a grapheme or emit an isolated surrogate. */
export function boundedUnicodeText(value, maximumLength, suffix = "") {
  const text = String(value).toWellFormed();
  if (text.length <= maximumLength) return text;
  const ending = suffix.toWellFormed();
  const budget = Math.max(0, maximumLength - ending.length);
  let end = 0;
  for (const part of graphemes.segment(text)) {
    const next = part.index + part.segment.length;
    if (next > budget) break;
    end = next;
  }
  return text.slice(0, end) + ending.slice(0, maximumLength);
}

/** Transport-only repair for historical malformed strings; stored evidence is untouched.
 * A replacer avoids cloning entire snapshots and applies equally to nested projections.
 */
export function clientSafeJSONStringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "string" ? entry.toWellFormed() : entry);
}
