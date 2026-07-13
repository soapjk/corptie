import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentPickerCard,
  buildCreateConfirmationCard,
  buildMessageCard,
  buildSessionListCard,
  buildWorkspacePickerCard
} from "../src/feishu/feishuGatewayManager.mjs";

function cardButtons(card) {
  return card.body.elements.flatMap((element) =>
    (element.columns ?? []).flatMap((column) => column.elements ?? [])
  ).filter((element) => element.tag === "button");
}

test("session list is a Card 2.0 card with direct session callbacks", () => {
  const card = buildSessionListCard({
    botId: "bot-a",
    sessions: [
      { id: "session-current", title: "Current", status: "running", external: { cwd: "/tmp/current" } },
      { id: "session-free", title: "Free", status: "idle", external: { cwd: "/tmp/free" } },
      { id: "session-busy", title: "Busy", status: "idle" }
    ],
    assignments: [
      { botId: "bot-a", sessionId: "session-current" },
      { botId: "bot-b", sessionId: "session-busy" }
    ],
    current: { botId: "bot-a", sessionId: "session-current" }
  });

  assert.equal(card.schema, "2.0");
  const buttons = cardButtons(card);
  const sessionButtons = buttons.filter((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "select_session"
  );
  assert.equal(sessionButtons.length, 3);
  assert.equal(sessionButtons[0].disabled, true);
  assert.equal(sessionButtons[1].disabled, false);
  assert.equal(sessionButtons[1].behaviors[0].value.session_id, "session-free");
  assert.equal(sessionButtons[2].disabled, true);
  assert.ok(buttons.some((button) => button.behaviors?.[0]?.value?.corptie_action === "refresh_sessions"));
  assert.ok(buttons.some((button) => button.behaviors?.[0]?.value?.corptie_action === "detach_session"));
});

test("session card paginates long lists", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    status: "idle"
  }));
  const card = buildSessionListCard({
    botId: "bot-a",
    sessions,
    page: 1,
    pageSize: 5
  });
  const buttons = cardButtons(card);
  const sessionButtons = buttons.filter((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "select_session"
  );
  assert.deepEqual(sessionButtons.map((button) => button.behaviors[0].value.session_id), ["session-5", "session-6"]);
  assert.ok(buttons.some((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "sessions_page" && button.behaviors[0].value.page === 0
  ));
});

test("ordinary bot output is wrapped in a Card 2.0 markdown message", () => {
  const card = buildMessageCard("**结果**\n\n任务已完成");
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "green");
  assert.equal(card.body.elements[0].tag, "markdown");
  assert.equal(card.body.elements[0].content, "**结果**\n\n任务已完成");
  assert.equal(card.config.summary.content, "结果 任务已完成");
});

test("session card exposes the new-session workflow", () => {
  const card = buildSessionListCard({ botId: "bot-a", sessions: [] });
  assert.ok(cardButtons(card).some((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "start_create_session"
  ));
});

test("workspace and agent cards carry opaque workspace ids instead of local paths", () => {
  const workspace = {
    id: "ws_opaque",
    name: "corptie",
    path: "/Users/example/projects/corptie"
  };
  const workspaceCard = buildWorkspacePickerCard({ workspaces: [workspace] });
  const workspaceAction = cardButtons(workspaceCard).find((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "select_workspace"
  )?.behaviors[0].value;
  assert.equal(workspaceAction.workspace_id, "ws_opaque");
  assert.equal(Object.hasOwn(workspaceAction, "path"), false);

  const agentCard = buildAgentPickerCard({ workspace });
  const agentActions = cardButtons(agentCard)
    .map((button) => button.behaviors?.[0]?.value)
    .filter((value) => value?.corptie_action === "select_create_agent");
  assert.deepEqual(agentActions.map((value) => value.agent), ["codex", "claude"]);
  assert.ok(agentActions.every((value) => value.workspace_id === "ws_opaque" && !Object.hasOwn(value, "path")));

  const confirmation = buildCreateConfirmationCard({ workspace, agent: "codex", replacesCurrentSession: true });
  const createAction = cardButtons(confirmation).find((button) =>
    button.behaviors?.[0]?.value?.corptie_action === "confirm_create_session"
  )?.behaviors[0].value;
  assert.deepEqual(createAction, {
    corptie_action: "confirm_create_session",
    workspace_id: "ws_opaque",
    agent: "codex"
  });
  assert.equal(Object.hasOwn(createAction, "path"), false);
});
