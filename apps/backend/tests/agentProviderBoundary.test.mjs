import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendSourceRoot = join(backendRoot, "src");
const macosSourceRoot = join(backendRoot, "..", "macos", "Sources", "CopetsMac");

const backendDebtBaseline = Object.freeze({
  "runtime/codexWorkspaceTransitionManager.mjs": 16,
  "server.mjs": 133
});

const frontendDebtBaseline = Object.freeze({});

test("concrete backend Provider dependencies cannot spread beyond the migration baseline", async () => {
  const files = await sourceFiles(backendSourceRoot, ".mjs");
  const actual = {};
  const pattern = /\b(?:codexClient|claudeAgents|ptyAgents|managedCodexSessions)\b/g;
  for (const file of files) {
    if (file.includes("/adapters/") || file.includes("/agent-provider/providers/")) continue;
    const count = ((await readFile(file, "utf8")).match(pattern) ?? []).length;
    if (count > 0) actual[relative(backendSourceRoot, file)] = count;
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(backendDebtBaseline).sort());
  for (const [file, count] of Object.entries(actual)) {
    assert.ok(
      count <= backendDebtBaseline[file],
      `${file} increased concrete Provider dependencies from ${backendDebtBaseline[file]} to ${count}`
    );
  }
});

test("frontend Provider-name branching cannot spread beyond the migration baseline", async () => {
  const files = await sourceFiles(macosSourceRoot, ".swift");
  const actual = {};
  const pattern = /provider\s*[!=]=\s*"(?:codex-app-server|codex-pty|claude-sdk|pty)"|isPtyProvider/g;
  for (const file of files) {
    const count = ((await readFile(file, "utf8")).match(pattern) ?? []).length;
    if (count > 0) actual[relative(macosSourceRoot, file)] = count;
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(frontendDebtBaseline).sort());
  for (const [file, count] of Object.entries(actual)) {
    assert.ok(
      count <= frontendDebtBaseline[file],
      `${file} increased Provider-name branching from ${frontendDebtBaseline[file]} to ${count}`
    );
  }
});

async function sourceFiles(root, extension) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...await sourceFiles(path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) results.push(path);
  }
  return results;
}
