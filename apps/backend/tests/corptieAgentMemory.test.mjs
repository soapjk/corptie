import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ARTIFACT_RUNTIME_POLICY } from "../src/application/artifactRuntimePolicy.mjs";
import { sessionResponsibilityInstructions } from "../src/application/sessionResponsibilityInstructions.mjs";
import { TASK_WORKSPACE_INSTRUCTIONS } from "../src/application/workSessionContext.mjs";

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
    "# Authoritative Work Session workspace",
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

test("existing shared memory replaces legacy Worktree autonomy with authoritative binding rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-memory-workspace-rules-"));
  const bundledMemoryPath = join(directory, "bundle", "global-instructions.md");
  const sharedMemoryPath = join(directory, ".corptie", "runtimes", "shared", "AGENT_MEMORY.md");
  await mkdir(join(directory, "bundle"), { recursive: true });
  await mkdir(join(directory, ".corptie", "runtimes", "shared"), { recursive: true });
  await writeFile(bundledMemoryPath, [
    "# Corptie runtime context",
    "",
    "- This is Corptie's {{CORPTIE_ENVIRONMENT}} environment.",
    "",
    "# Authoritative Work Session workspace",
    "",
    "- Continue in the bound Workspace.",
    "- Create or switch only when the direct user explicitly requests it.",
    "",
    "# External actions: local-only by default",
    "",
    "Bundled external rule.",
    ""
  ].join("\n"));
  await writeFile(sharedMemoryPath, [
    "# Corptie runtime context",
    "",
    "Existing runtime context.",
    "",
    "# UI engineering priority",
    "",
    "Preserve this customization.",
    "",
    "# Git worktree isolation",
    "",
    "The model may create a task Worktree without a user request.",
    "",
    "# External actions: local-only by default",
    "",
    "Preserve the installed external action rules.",
    ""
  ].join("\n"));

  try {
    const first = await ensureCorptieAgentMemory({
      corptieHome: join(directory, ".corptie"),
      environmentName: "production",
      bundledMemoryPath
    });
    const content = await readFile(sharedMemoryPath, "utf8");
    assert.equal(first.created, false);
    assert.equal(first.updatedManagedWorkspaceRules, true);
    assert.match(content, /# Authoritative Work Session workspace/);
    assert.match(content, /only when the direct user explicitly requests it/);
    assert.doesNotMatch(content, /# Git worktree isolation|may create a task Worktree/);
    assert.match(content, /Preserve this customization/);
    assert.match(content, /Preserve the installed external action rules/);

    const second = await ensureCorptieAgentMemory({
      corptieHome: join(directory, ".corptie"),
      environmentName: "production",
      bundledMemoryPath
    });
    assert.equal(second.updatedManagedWorkspaceRules, false);
    assert.equal(await readFile(sharedMemoryPath, "utf8"), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared Provider memory has no Task binding; only Worker Turn context binds a Worktree", async () => {
  for (const relativePath of [
    "../resources/agent/global-instructions.development.md",
    "../resources/agent/global-instructions.production.md"
  ]) {
    const content = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(content, /programmatically creates and binds the Task Worktree/u);
  }
  assert.equal(sessionResponsibilityInstructions("worker"), "");
  assert.match(TASK_WORKSPACE_INSTRUCTIONS, /only when the direct user explicitly requests it/);
  assert.match(TASK_WORKSPACE_INSTRUCTIONS, /Ordinary development is not authorization/);
  for (const kind of ["workChat", "assistantChat"]) assert.ok(sessionResponsibilityInstructions(kind).includes(ARTIFACT_RUNTIME_POLICY));
});

test("Artifact policy upgrades existing runtime memory once and preserves unrelated user memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-runtime-policy-"));
  try {
    const options = { corptieHome: directory, bundledMemoryPath: new URL("../resources/agent/global-instructions.production.md", import.meta.url).pathname };
    const first = await ensureCorptieAgentMemory(options);
    const current = await readFile(first.sharedMemoryPath, "utf8");
    assert.ok(current.includes(ARTIFACT_RUNTIME_POLICY));
    await writeFile(first.sharedMemoryPath, "# User memory\n\nKeep this preference.\n\n# Markdown version-control policy\n\nStore notes as ordinary files.\n");
    assert.equal((await ensureCorptieAgentMemory(options)).updatedManagedWorkspaceRules, true);
    const upgraded = await readFile(first.sharedMemoryPath, "utf8");
    assert.match(upgraded, /Keep this preference/);
    assert.doesNotMatch(upgraded, /Store notes as ordinary files/);
    assert.ok(upgraded.includes(ARTIFACT_RUNTIME_POLICY));
    assert.equal((await ensureCorptieAgentMemory(options)).updatedManagedWorkspaceRules, false);
    assert.equal(await readFile(first.sharedMemoryPath, "utf8"), upgraded);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
