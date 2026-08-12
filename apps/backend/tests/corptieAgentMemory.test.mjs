import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureCorptieAgentMemory,
  ensureProviderMemoryLink
} from "../src/runtime/corptieAgentMemory.mjs";

test("Codex and Claude native memory files share one preserved Corptie memory source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-memory-"));
  const bundledMemoryPath = join(directory, "bundle", "global-instructions.md");
  const legacyCodexMemoryPath = join(directory, ".corptie", "runtimes", "codex", "AGENTS.md");
  const claudeMemoryPath = join(directory, ".corptie", "runtimes", "claude", "CLAUDE.md");
  await mkdir(join(directory, "bundle"), { recursive: true });
  await mkdir(join(directory, ".corptie", "runtimes", "codex"), { recursive: true });
  await writeFile(bundledMemoryPath, [
    "# Corptie runtime context",
    "",
    "- This is Corptie's {{CORPTIE_ENVIRONMENT}} environment.",
    "",
    "# Git worktree isolation",
    "",
    "Bundled worktree rule.",
    ""
  ].join("\n"));
  await writeFile(legacyCodexMemoryPath, [
    "# Corptie runtime context",
    "",
    "- You are running inside Corptie, an Agent client powered by the official Codex runtime.",
    "- This is Corptie's production environment.",
    "- The active Codex configuration and state directory (`CODEX_HOME`) is `/tmp/codex`.",
    "- Treat that directory as authoritative for this session. Do not assume or modify the native Codex home at `~/.codex` unless the user explicitly asks.",
    "",
    "# User memory",
    "",
    "Preserve this customization.",
    ""
  ].join("\n"));

  try {
    const memory = await ensureCorptieAgentMemory({
      corptieHome: join(directory, ".corptie"),
      environmentName: "production",
      bundledMemoryPath,
      legacyMemoryPath: legacyCodexMemoryPath
    });
    await ensureProviderMemoryLink(memory.sharedMemoryPath, legacyCodexMemoryPath);
    await ensureProviderMemoryLink(memory.sharedMemoryPath, claudeMemoryPath);

    const content = await readFile(memory.sharedMemoryPath, "utf8");
    assert.match(content, /Corptie's production environment/);
    assert.match(content, /Preserve this customization/);
    assert.doesNotMatch(content, /CODEX_HOME|official Codex runtime/);
    assert.equal(await realpath(legacyCodexMemoryPath), await realpath(claudeMemoryPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
