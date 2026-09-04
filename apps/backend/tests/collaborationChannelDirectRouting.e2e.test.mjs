import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { callCollaborationDynamicTool } from "../src/collaboration/collaborationDynamicTools.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { SessionChannelService } from "../src/collaboration/sessionChannelService.mjs";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("explicit @Session aliases route in one HTTP call across confirmation, reuse, missing, and ambiguity", async () => {
  const value = await fixture();
  try {
    const direct = await measuredOpen(value, {
      recipient_session_name: "@automation工具维护",
      body: "Please inspect the Automation tool.",
      idempotency_key: "direct:first"
    });
    assert.equal(direct.calls, 1);
    assert.equal(direct.aliasLookups, 1);
    assert.ok(direct.durationMs < 500, `direct alias route took ${direct.durationMs}ms`);
    assert.equal(direct.result.request.status, "pending");
    assert.equal(direct.result.request.requestedRecipientSessionId, "logical:automation");
    assert.equal(value.staged.length, 1);

    const confirmed = value.channels.confirmRequest(direct.result.request.requestId, {
      recipientSessionId: "logical:automation"
    }, { type: "direct_user" });
    assert.equal(confirmed.status, "confirmed");

    const reused = await measuredOpen(value, {
      recipient_session_name: "automation工具维护",
      body: "Follow up through the existing Channel.",
      idempotency_key: "direct:reuse"
    });
    assert.equal(reused.calls, 1);
    assert.equal(reused.aliasLookups, 1);
    assert.ok(reused.durationMs < 500, `active Channel reuse took ${reused.durationMs}ms`);
    assert.equal(reused.result.request.status, "sent");
    assert.equal(reused.result.request.routeAuthorization, "active_channel");
    assert.equal(reused.result.request.channel.channelId, confirmed.channelId);

    const missing = await measuredOpenError(value, {
      recipient_session_name: "@missing-session",
      body: "This should not enumerate Agents.",
      idempotency_key: "direct:missing"
    });
    assert.equal(missing.calls, 1);
    assert.equal(missing.aliasLookups, 1);
    assert.equal(missing.error.code, "RECIPIENT_SESSION_NOT_FOUND");
    assert.equal(missing.error.details.resolution, "not_found");
    assert.equal(missing.error.details.nextAction, "corptie_sessions_discover");

    value.store.db.run(
      `INSERT INTO session_name_aliases (alias_key, alias, logical_session_id, created_at)
       VALUES (?, ?, ?, ?)`,
      ["automation工具维护", "automation工具维护", "logical:ambiguous", new Date().toISOString()]
    );
    const ambiguous = await measuredOpenError(value, {
      recipient_session_name: "@automation工具维护",
      body: "This should return candidates, not guess.",
      idempotency_key: "direct:ambiguous"
    });
    assert.equal(ambiguous.calls, 1);
    assert.equal(ambiguous.aliasLookups, 1);
    assert.equal(ambiguous.error.code, "RECIPIENT_SESSION_ALIAS_AMBIGUOUS");
    assert.equal(ambiguous.error.details.resolution, "ambiguous");
    assert.deepEqual(
      ambiguous.error.details.candidates.map((candidate) => candidate.sessionId).sort(),
      ["logical:ambiguous", "logical:automation"]
    );
  } finally {
    await new Promise((resolve) => value.server.close(resolve));
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("bundled Skill and runtime instruction use exact-alias-first routing", async () => {
  const skill = await readFile(new URL(
    "../resources/codex/skills/corptie-collaboration/SKILL.md", import.meta.url
  ), "utf8");
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

  assert.match(skill, /call `corptie_collaboration_channel_open` directly/);
  assert.match(skill, /do not pre-discover Sessions or Agents/);
  assert.match(skill, /Only after `RECIPIENT_SESSION_NOT_FOUND` or `RECIPIENT_SESSION_ALIAS_AMBIGUOUS`/);
  assert.match(skill, /requires the direct user's explicit confirmation/);
  assert.match(skill, /target Work and Agent resources/);
  assert.match(server, /call corptie_collaboration_channel_open directly with recipient_session_name/);
});

async function measuredOpen(value, args) {
  const before = value.callCount();
  const lookupsBefore = value.aliasLookupCount();
  const started = performance.now();
  const result = await callCollaborationDynamicTool(value.client, "corptie_collaboration_channel_open", args);
  return {
    result,
    calls: value.callCount() - before,
    aliasLookups: value.aliasLookupCount() - lookupsBefore,
    durationMs: performance.now() - started
  };
}

async function measuredOpenError(value, args) {
  const before = value.callCount();
  const lookupsBefore = value.aliasLookupCount();
  const started = performance.now();
  let error;
  try {
    await callCollaborationDynamicTool(value.client, "corptie_collaboration_channel_open", args);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  return {
    error,
    calls: value.callCount() - before,
    aliasLookups: value.aliasLookupCount() - lookupsBefore,
    durationMs: performance.now() - started
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-channel-direct-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json")
  });
  await store.initialize();
  let aliasLookups = 0;
  const findLogicalSessionsByName = store.findLogicalSessionsByName.bind(store);
  store.findLogicalSessionsByName = (...args) => {
    aliasLookups += 1;
    return findLogicalSessionsByName(...args);
  };
  const core = new CollaborationCore(store);
  const works = new WorkApplicationService({ store });
  const source = store.createAgent({ id: "agent:source", name: "Source", role: "independentContributor" });
  const target = store.createAgent({ id: "agent:target", name: "Target", role: "independentContributor" });
  const sourceWork = works.createWork({
    id: "work:source", name: "Source", contributorAgentIds: [source.agentId]
  });
  const targetWork = works.createWork({
    id: "work:target", name: "Target", contributorAgentIds: [target.agentId]
  });
  bind(store, core, directory, {
    logicalSessionId: "logical:source", providerSessionId: "provider:source",
    sessionName: "source-session", agentId: source.agentId, workId: sourceWork.id, taskId: "task:source"
  });
  bind(store, core, directory, {
    logicalSessionId: "logical:automation", providerSessionId: "provider:automation",
    sessionName: "automation工具维护", agentId: target.agentId, workId: targetWork.id, taskId: "task:automation"
  });
  bind(store, core, directory, {
    logicalSessionId: "logical:ambiguous", providerSessionId: "provider:ambiguous",
    sessionName: "another-session", agentId: target.agentId, workId: targetWork.id, taskId: "task:ambiguous"
  });

  const collaboration = new SessionCollaborationService({
    store, workService: works, collaborationCore: core, defaultProviderId: "test-provider",
    workSessionStartApplicationService: { start: async () => { throw new Error("unexpected start"); } }
  });
  const channels = new SessionChannelService({ store, collaborationCore: core });
  const staged = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!handleCollaborationHttpRequest({
      request, response, url, core, sessionCollaborationService: collaboration,
      sessionChannelService: channels,
      onChannelRequestStaged: async (requestValue) => staged.push(requestValue)
    })) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let calls = 0;
  const client = new CollaborationHttpClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    agentId: source.agentId,
    sessionScope: { sessionId: "provider:source", workId: sourceWork.id, taskId: "task:source" },
    fetch: (...args) => { calls += 1; return fetch(...args); }
  });
  return {
    directory, store, server, channels, staged, client,
    callCount: () => calls,
    aliasLookupCount: () => aliasLookups
  };
}

function bind(store, core, directory, input) {
  store.createTask({
    id: input.taskId, workId: input.workId, title: input.taskId, mainAgentId: input.agentId
  }, { originType: "direct_user" });
  store.createSession({
    id: input.providerSessionId, title: input.sessionName, agentId: input.agentId,
    sessionKind: "worker", workId: input.workId, taskId: input.taskId, cwd: directory
  });
  store.createLogicalSessionRoute({
    logicalSessionId: input.logicalSessionId, legacySessionId: input.providerSessionId,
    providerThreadId: `thread:${input.providerSessionId}`, providerSessionId: input.providerSessionId,
    providerId: "test-provider", boundCwd: directory, sessionName: input.sessionName
  });
  core.bindSession({ agentId: input.agentId, sessionId: input.providerSessionId });
}
