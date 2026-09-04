import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const requestPath = process.argv[2];
if (!requestPath) fail("SEMANTIC_REQUEST_REQUIRED");

try {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  assertRequest(request);
  const root = await realpath(process.cwd());
  const queryTokens = tokens(request.query);
  const results = [];
  for (const candidate of request.candidates) {
    const absolute = resolve(root, candidate.path);
    const resolved = await realpath(absolute);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || (resolved !== root && !resolved.startsWith(`${root}${sep}`))) {
      fail("SEMANTIC_PATH_OUTSIDE_SNAPSHOT");
    }
    const content = info.size <= 2 * 1024 * 1024 ? await readFile(resolved, "utf8") : "";
    const pathTokens = tokens(candidate.path);
    const contentTokens = tokens(content.slice(0, 2 * 1024 * 1024));
    const overlap = [...queryTokens].filter((token) => pathTokens.has(token) || contentTokens.has(token));
    if (overlap.length === 0) continue;
    const line = firstMatchingLine(content, overlap);
    results.push({
      path: candidate.path,
      line,
      symbol: null,
      kind: "semantic",
      score: Math.min(1, overlap.length / Math.max(1, queryTokens.size)),
      snippet: lineAt(content, line)
    });
  }
  results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    sourceFingerprint: request.sourceFingerprint,
    results: results.slice(0, request.limit)
  }));
} catch (error) {
  fail(error?.code ?? "SEMANTIC_WORKER_FAILED");
}

function assertRequest(value) {
  const fields = ["schemaVersion", "query", "limit", "sourceFingerprint", "candidates"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))
    || value.schemaVersion !== 1
    || typeof value.query !== "string"
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 50
    || !/^[0-9a-f]{64}$/.test(value.sourceFingerprint)
    || !Array.isArray(value.candidates) || value.candidates.length > 100_000) {
    fail("SEMANTIC_REQUEST_INVALID");
  }
  for (const candidate of value.candidates) {
    if (!candidate || Object.keys(candidate).length !== 2
      || typeof candidate.path !== "string" || candidate.path.length === 0
      || candidate.path.startsWith("/") || candidate.path.split("/").includes("..")
      || typeof candidate.language !== "string") {
      fail("SEMANTIC_REQUEST_INVALID");
    }
  }
}

function tokens(value) {
  const source = String(value).normalize("NFKC");
  const expanded = source.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const result = new Set(expanded.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2));
  const concepts = [
    ["恢复", ["restore", "resume", "recover"]], ["会话", ["session"]], ["阅读", ["read", "viewport"]], ["位置", ["position", "viewport", "scroll"]],
    ["创建", ["create"]], ["任务", ["task"]], ["立即", ["start", "immediate"]], ["启动", ["start"]], ["工作", ["work"]],
    ["描述", ["description"]], ["上下文", ["context", "prompt"]], ["消息", ["message", "chat"]], ["验收", ["acceptance"]]
  ];
  for (const [term, translations] of concepts) if (source.includes(term)) for (const token of translations) result.add(token);
  return result;
}

function firstMatchingLine(content, overlap) {
  const lines = content.split("\n", 10_000);
  const lowered = overlap.map((token) => token.toLocaleLowerCase("en-US"));
  const index = lines.findIndex((line) => lowered.some((token) => line.toLocaleLowerCase("en-US").includes(token)));
  return index >= 0 ? index + 1 : 1;
}

function lineAt(content, line) {
  return (content.split(/\r?\n/)[line - 1] ?? "").trim().slice(0, 240);
}

function fail(code) {
  process.stderr.write(JSON.stringify({ code }));
  process.exit(70);
}
