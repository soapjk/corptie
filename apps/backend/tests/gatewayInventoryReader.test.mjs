import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayInventoryReader } from "../src/application/gatewayInventoryReader.mjs";

function fixture() {
  const rows = [
    { id: "active", sessionKind: "assistantChat", archived: false, external: { cwd: "/workspace" }, updatedAt: "2026-01-01T00:00:00Z" },
    { id: "archived", sessionKind: "worker", archived: true, external: { cwd: "/workspace/../workspace" }, updatedAt: "2026-02-01T00:00:00Z" },
    { id: "invalid", sessionKind: "legacy", archived: false, external: { cwd: "/excluded" } },
    { id: "relative", sessionKind: "worker", archived: true, external: { cwd: "relative" } }
  ];
  const reader = createGatewayInventoryReader({
    store: {
      listSessions: ({ archived }) => rows.filter((row) => row.archived === archived),
      listSessionPage: () => ({ items: [rows[0]], hasMore: true, nextCursor: "cursor" }),
      settings: () => ({ gateway: { trustedWorkspaces: ["/favorite", "relative"] } }),
      getTask: () => ({ title: "Task", status: "active", main_agent_id: "agent" }),
      getAgent: () => ({ name: "Agent" })
    },
    decorateSessionForClient: (session) => ({ ...session, decorated: true }),
    now: () => "2026-03-01T00:00:00Z"
  });
  return reader;
}

test("resident gateway list excludes legacy rows and decorates product sessions", () => {
  const reader = fixture();
  const sessions = reader.listGatewaySessions();
  assert.deepEqual(sessions.map((session) => session.id), ["active"]);
  assert.equal(sessions[0].decorated, true);
});

test("paged gateway list preserves continuation metadata", () => {
  const page = fixture().listGatewaySessionPage({ limit: 1 });
  assert.equal(page.nextCursor, "cursor");
  assert.equal(page.hasMore, true);
  assert.equal(page.items[0].decorated, true);
});

test("workspaces deduplicate canonical paths and retain favorites and latest history", () => {
  const workspaces = fixture().listGatewayWorkspaces();
  assert.deepEqual(workspaces.map((workspace) => workspace.path), ["/favorite", "/workspace"]);
  assert.equal(workspaces[0].favorite, true);
  assert.equal(workspaces[1].updatedAt, "2026-02-01T00:00:00Z");
});

test("session description resolves its task and assigned agent", () => {
  assert.deepEqual(fixture().describeGatewaySession({ id: "active", taskId: "task" }), {
    agentName: "Agent", taskTitle: "Task", taskStatus: "active"
  });
});
