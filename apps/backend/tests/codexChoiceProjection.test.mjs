import assert from "node:assert/strict";
import test from "node:test";
import { createCodexChoiceProjection } from "../src/adapters/codexChoiceProjection.mjs";

const drain = () => new Promise((resolve) => setImmediate(resolve));

function fixture(overrides = {}) {
  const writes = [];
  const session = { id: "stored", summary: "Choose A or B", status: "idle" };
  let finish;
  let parses = 0;
  const projection = createCodexChoiceProjection({
    store: {
      settings: () => ({ choiceParser: { provider: "openai", openaiModel: "model" } }),
      getLogicalSessionByProviderThreadId: () => ({ legacySessionId: session.id }),
      getSession: () => session,
      setActiveChoicePrompt: (...args) => writes.push(["prompt", ...args])
    },
    developmentPreview: false,
    upsertManagedCodexSession: (value) => writes.push(["session", value]),
    emitEvent: () => {},
    now: () => "2026-01-01T00:00:00Z",
    shouldUseModel: () => true,
    parseChoices: () => { parses += 1; return new Promise((resolve) => { finish = resolve; }); },
    ...overrides
  });
  return {
    projection, writes, session, parseCount: () => parses,
    finish: () => finish({
      confidence: 0.9, selectedIndex: 0,
      options: [{ label: "A" }, { label: "B" }]
    })
  };
}

test("duplicate pending parses are coalesced and accepted results become cached", async () => {
  const f = fixture();
  f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
  f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
  assert.equal(f.parseCount(), 1);
  assert.equal(f.projection.pendingCount, 1);
  f.finish();
  await drain();
  assert.equal(f.projection.pendingCount, 0);
  assert.deepEqual(f.writes.map(([kind]) => kind), ["session", "prompt"]);
  assert.equal(f.writes[0][1].suggestedOptions[0].selected, true);
  f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
  assert.equal(f.parseCount(), 1);
  assert.equal(f.writes.length, 4);
});

test("a newer message generation prevents an earlier asynchronous result from changing the session", async () => {
  const f = fixture();
  f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
  f.projection.bumpChoiceGeneration("stored");
  f.finish();
  await drain();
  assert.deepEqual(f.writes, []);
  assert.equal(f.projection.pendingCount, 0);
});

test("running sessions and replaced summaries reject stale choices", async () => {
  for (const mutate of [
    (session) => { session.status = "running"; },
    (session) => { session.summary = "Unrelated replacement message"; }
  ]) {
    const f = fixture();
    f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
    mutate(f.session);
    f.finish();
    await drain();
    assert.deepEqual(f.writes, []);
  }
});

test("development preview does not schedule background model work", () => {
  const f = fixture({ developmentPreview: true });
  f.projection.scheduleCodexChoiceParseForText("thread", "Choose A or B");
  assert.equal(f.parseCount(), 0);
  assert.equal(f.projection.pendingCount, 0);
});
