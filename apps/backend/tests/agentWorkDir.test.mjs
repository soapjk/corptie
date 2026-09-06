import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  effectiveAgentWorkDir,
  ensureAgentWorkDir,
  recoverableAgentWorkDir,
  resolveAgentWorkDir
} from "../src/runtime/agentWorkDir.mjs";

test("Agent default workspaces are isolated by agent id", () => {
  const options = { corptieHome: "/tmp/corptie-agent-work-dir", environmentName: "development" };
  const first = resolveAgentWorkDir({ agentId: "agent:first" }, options);
  const second = resolveAgentWorkDir({ agentId: "agent:second" }, options);

  assert.notEqual(first, second);
  assert.match(first, /agents\/agent%3Afirst\/workspace$/);
  assert.match(second, /agents\/agent%3Asecond\/workspace$/);
});

test("Workspace recovery accepts any Agent's exact managed work directory", () => {
  const options = { corptieHome: "/tmp/corptie-agent-work-dir", environmentName: "development" };
  const agent = { agentId: "agent:recoverable" };
  const expected = effectiveAgentWorkDir(agent, options);

  assert.equal(recoverableAgentWorkDir(agent, expected, options), expected);
  assert.equal(recoverableAgentWorkDir(agent, "/tmp/unrelated-workspace", options), null);
  assert.equal(recoverableAgentWorkDir({ ...agent }, expected, options), expected);
});

test("Agent runtime uses the persisted workDir for every Provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-work-dir-"));
  const configured = join(directory, "custom-assistant-workspace");
  const agent = {
    agentId: "assistant:custom",
    provider: "claude-sdk",
    workDir: configured
  };

  try {
    assert.equal(effectiveAgentWorkDir(agent), configured);
    assert.equal(await ensureAgentWorkDir(agent), configured);
    assert.equal((await stat(configured)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
