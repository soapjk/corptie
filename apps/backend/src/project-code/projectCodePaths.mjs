import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256Hex, contractError } from "./projectCodeContracts.mjs";

export const PROJECT_CODE_EXCLUSION_REVISION = "project-code-exclusions/v4";

const excludedSegments = new Set([
  ".git", ".build", "build", "DerivedData", "dist", "out", "coverage", "target",
  "node_modules", "vendor", "Pods", "Carthage", ".gradle", ".cache", "__pycache__"
]);

export function normalizeRelativePath(input) {
  if (typeof input !== "string" || !input || input.includes("\0") || input.includes("\\") || isAbsolute(input)) {
    throw pathError("PATH_INVALID", "Search paths must be non-empty POSIX relative paths.", input);
  }
  const normalized = input.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw pathError("PATH_INVALID", "Search paths cannot contain empty or dot segments.", input);
  }
  return normalized;
}
export function defaultExclusionReason(relativePath, options = {}) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => excludedSegments.has(segment))) return "DEFAULT_EXCLUDED_SPACE";
  if (segments[0] === ".corptie" && segments[1] === "worktrees") return "OTHER_WORKTREE";
  if (segments.some((segment) => /^(?:generated|codegen)$/i.test(segment)) && !options.generatedAllowed) {
    return "GENERATED_SOURCE_NOT_ALLOWED";
  }
  return null;
}

export async function assertContainedRegularPath(root, requestedPath, options = {}) {
  const canonicalRoot = await realpath(root);
  const relativePath = normalizeRelativePath(requestedPath);
  const exclusion = defaultExclusionReason(relativePath, options);
  if (exclusion) throw pathError("PATH_OUTSIDE_SCOPE", "The requested source path is excluded from project-code search.", requestedPath, exclusion);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isDescendant(canonicalRoot, candidate)) throw pathError("PATH_OUTSIDE_SCOPE", "The requested path escapes the authoritative Worktree.", requestedPath);

  let cursor = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    cursor = resolve(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw pathError("PATH_OUTSIDE_SCOPE", "Symbolic links are metadata-only and cannot be searched or read.", requestedPath, "SYMLINK_FORBIDDEN");
  }
  const canonicalCandidate = await realpath(candidate);
  if (!isDescendant(canonicalRoot, canonicalCandidate)) {
    throw pathError("PATH_OUTSIDE_SCOPE", "The requested path resolves outside the authoritative Worktree.", requestedPath, "SYMLINK_ESCAPE");
  }
  const info = await lstat(canonicalCandidate);
  if (!options.allowDirectory && !info.isFile()) throw pathError("PATH_INVALID", "The requested source path is not a regular file.", requestedPath);
  return { canonicalRoot, absolutePath: canonicalCandidate, relativePath, info };
}

export function assertNotOtherWorktree(canonicalRoot, candidatePath, otherWorktreeRoots = []) {
  const candidate = resolve(candidatePath);
  for (const root of otherWorktreeRoots) {
    const other = resolve(root);
    if (other !== resolve(canonicalRoot) && isDescendant(other, candidate)) {
      throw pathError("PATH_OUTSIDE_SCOPE", "Paths belonging to another Worktree are not searchable.", candidatePath, "OTHER_WORKTREE");
    }
  }
}

export function rejectedPathFact(path, reasonCode, { revealRelative = false } = {}) {
  return Object.freeze({
    relativePath: revealRelative ? String(path).normalize("NFC") : null,
    pathHash: sha256Hex(Buffer.from(String(path).normalize("NFC"), "utf8")),
    reasonCode
  });
}

export function isDescendant(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export function pathError(code, message, path, reasonCode = code) {
  const error = contractError(code, message, code === "PATH_OUTSIDE_SCOPE" ? 403 : 400);
  error.rejectedPath = rejectedPathFact(path, reasonCode, { revealRelative: !isAbsolute(String(path ?? "")) });
  return error;
}
