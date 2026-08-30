const CLASS_BY_EXECUTABLE = new Map([
  ["swift", "build"], ["xcodebuild", "build"], ["cargo", "build"], ["make", "build"], ["cmake", "build"],
  ["rg", "search"], ["grep", "search"], ["find", "search"], ["fd", "search"],
  ["git", "version_control"], ["gh", "version_control"],
  ["rm", "cleanup"], ["rmdir", "cleanup"], ["trash", "cleanup"],
  ["launchctl", "service_start"], ["systemctl", "service_start"]
]);

export function classifyStructuredProcess(input) {
  if (!input || typeof input !== "object") return unknownResult("invalid");
  if (input.receiptClass) return result(input.receiptClass, "run_isolation_receipt", "high", input.operationSet);
  const executable = basename(input.executable);
  const args = Array.isArray(input.argumentKinds) ? input.argumentKinds : [];
  if (executable === "swift" && args.includes("test")) return result("test", "structured_process", "high");
  if (["npm", "pnpm", "yarn"].includes(executable) && args.some((value) => value === "test" || value === "build")) {
    return result(args.includes("test") ? "test" : "build", "structured_process", "high");
  }
  if (["node", "python", "python3"].includes(executable) && input.role === "service") return result("service_start", "structured_process", "high");
  return result(CLASS_BY_EXECUTABLE.get(executable) ?? "unknown", "structured_process", CLASS_BY_EXECUTABLE.has(executable) ? "high" : "none");
}

export function decomposeShellFallback(command) {
  if (typeof command !== "string" || !command.trim()) return { parseStatus: "invalid", segments: [], operationSet: [], classificationConfidence: "none" };
  if (command.length > 16_384 || /[`]|\$\(|<<|\r/.test(command)) {
    return { parseStatus: "unsafe", segments: [], operationSet: [], classificationConfidence: "none" };
  }
  const rawSegments = command.split(/\s*(?:&&|\|\||[;|\n])\s*/).filter(Boolean).slice(0, 128);
  const segments = rawSegments.map((segment, ordinal) => {
    const tokens = safeTokens(segment);
    const executable = basename(tokens[0]);
    let intervalClass = CLASS_BY_EXECUTABLE.get(executable) ?? "unknown";
    if (executable === "swift" && tokens[1] === "test") intervalClass = "test";
    if (["npm", "pnpm", "yarn"].includes(executable) && tokens.includes("test")) intervalClass = "test";
    if (["npm", "pnpm", "yarn"].includes(executable) && tokens.includes("build")) intervalClass = "build";
    return { ordinal, intervalClass, executable: executable || null };
  });
  const operationSet = [...new Set(segments.map((segment) => segment.intervalClass))];
  return { parseStatus: "parsed", segments, operationSet,
    classificationConfidence: operationSet.includes("unknown") ? "low" : "medium" };
}

function safeTokens(segment) {
  return segment.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "")).slice(0, 32);
}
function basename(value) { return typeof value === "string" ? value.split("/").pop()?.toLowerCase() ?? "" : ""; }
function result(intervalClass, classificationSource, classificationConfidence, operationSet) {
  return { intervalClass, classificationSource, classificationConfidence,
    operationSet: Array.isArray(operationSet) ? [...new Set(operationSet)] : [intervalClass] };
}
function unknownResult(parseStatus) { return { ...result("unknown", "unknown", "none"), parseStatus }; }
