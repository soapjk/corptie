import { boundedUnicodeText } from "./unicodeText.mjs";
const MAX_CHANGES = 50;
const MAX_PATH = 1_024;
const MAX_DIFF_PREVIEW = 2_000;
const MAX_TOTAL_DIFF_PREVIEW = 8_000;

export function changeSetForCodexItem(item) {
  if (item?.type !== "fileChange" || !Array.isArray(item.changes)) return null;
  return publicChangeSet({
    schemaVersion: 1,
    truncated: item.changes.length > MAX_CHANGES,
    changes: item.changes.slice(0, MAX_CHANGES).map((change) => ({
      path: change?.path,
      kind: change?.kind?.type ?? change?.kind,
      diffPreview: change?.diff ?? null
    }))
  });
}

export function changeSetForClaudeTool(name, input, output = null) {
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return null;
  const path = output?.filePath ?? output?.file_path ?? input?.file_path ?? input?.notebook_path;
  if (typeof path !== "string" || !path) return null;
  const kind = output?.type === "create" ? "add"
    : output || name !== "Write" ? "modify" : "unknown";
  const diff = output?.gitDiff?.patch ?? structuredPatchText(output?.structuredPatch) ?? null;
  return publicChangeSet({ schemaVersion: 1, truncated: false, changes: [
    { path, kind, diffPreview: diff }
  ] });
}

export function publicChangeSet(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.changes)) return null;
  let remainingDiffCharacters = MAX_TOTAL_DIFF_PREVIEW;
  const changes = value.changes.slice(0, MAX_CHANGES).flatMap((change) => {
    if (typeof change?.path !== "string" || !change.path || change.path.length > MAX_PATH) return [];
    const kind = normalizeKind(change.kind);
    const diff = typeof change.diffPreview === "string" ? change.diffPreview : null;
    const previewLength = Math.min(diff?.length ?? 0, MAX_DIFF_PREVIEW, remainingDiffCharacters);
    const diffPreview = previewLength > 0 ? boundedUnicodeText(diff, previewLength) : null;
    remainingDiffCharacters -= previewLength;
    return [{ path: change.path, kind,
      diffPreview,
      diffTruncated: change.diffTruncated === true || (diff?.length ?? 0) > previewLength }];
  });
  return { schemaVersion: 1, truncated: value.truncated === true || value.changes.length > MAX_CHANGES,
    changes };
}

export function withChangeSetMetadata(rawMetadataJSON, changeSet) {
  if (!changeSet) return rawMetadataJSON;
  let metadata = {};
  try {
    const parsed = JSON.parse(rawMetadataJSON);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch { /* Keep the normalized projection even if diagnostic metadata is absent. */ }
  return JSON.stringify({ ...metadata, changeSet });
}

function normalizeKind(value) {
  switch (String(value ?? "").toLowerCase()) {
  case "add": case "added": case "create": return "add";
  case "delete": case "deleted": case "remove": return "delete";
  case "update": case "updated": case "modify": case "modified": return "modify";
  default: return "unknown";
  }
}

function structuredPatchText(value) {
  if (!Array.isArray(value)) return null;
  return value.flatMap((hunk) => Array.isArray(hunk?.lines) ? hunk.lines : []).join("\n");
}
