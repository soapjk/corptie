import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTopicService } from "../src/application/memoryTopicService.mjs";

test("session topics change with conversation while short follow-ups reuse the current classification", async () => {
  let profile = null;
  let calls = 0;
  const store = {
    getSessionMemoryTopics: () => profile ? { profile } : null,
    upsertSessionMemoryTopics: (_id, next) => { profile = next; },
    getTask: () => ({ title: "MarketCow SDK" }),
    getWork: () => ({ name: "MarketCow" })
  };
  const service = new MemoryTopicService({ store, classify: async ({ message }) => {
    calls += 1;
    return message.includes("公猫")
      ? { topics: ["personal"], contexts: ["personal"], keywords: [] }
      : { topics: ["programming"], contexts: ["development"], keywords: ["MarketCow"] };
  } });
  const session = { id: "session:a", sessionKind: "worker", taskId: "task:a", workId: "work:a" };
  const first = await service.update(session, "讨论 MarketCow SDK");
  assert.deepEqual(first.contexts, ["development"]);
  assert.deepEqual((await service.update(session, "继续")).topics, ["programming"]);
  assert.equal(calls, 1);
  const switched = await service.update(session, "我养的公猫需要什么");
  assert.deepEqual(switched.topics, ["personal"]);
  assert.deepEqual(switched.contexts, ["personal"]);
  assert.equal(calls, 2);
});
