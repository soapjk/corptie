import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { AssistantService, createAssistantIntentResolver } from "../src/application/assistantService.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("assistant.chat 建目标（规则版意图识别）", async () => {
  const { store, directory } = await createStore();
  try {
    const objectiveService = new ObjectiveApplicationService({ store });
    const assistant = new AssistantService({ store, objectiveService });

    const result = await assistant.chat("建目标 重构 Corptie");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    const receipt = result.messages[1];
    assert.equal(receipt.kind, "receipt");
    assert.equal(receipt.data.type, "objective");
    assert.equal(receipt.data.objective.name, "重构 Corptie");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistant.chat 建工作项（无目标时自动建默认目标）", async () => {
  const { store, directory } = await createStore();
  try {
    const objectiveService = new ObjectiveApplicationService({ store });
    const assistant = new AssistantService({ store, objectiveService });

    const result = await assistant.chat("建工作项 拆巨文件");
    const receipt = result.messages[1];
    assert.equal(receipt.kind, "receipt");
    assert.equal(receipt.data.type, "task");
    assert.equal(receipt.data.task.title, "拆巨文件");
    assert.equal(receipt.data.objective.name, "默认目标");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistant.chat 查记忆 + 兜底回复", async () => {
  const { store, directory } = await createStore();
  try {
    const objectiveService = new ObjectiveApplicationService({ store });
    const assistant = new AssistantService({ store, objectiveService });

    const memory = await assistant.chat("查记忆");
    assert.equal(memory.messages[1].kind, "memory");

    const fallback = await assistant.chat("讲个笑话");
    assert.equal(fallback.messages[1].role, "assistant");
    assert.ok(fallback.messages[1].content.includes("建目标"));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentResolver 注入：LLM 识别意图生效", async () => {
  const { store, directory } = await createStore();
  try {
    const objectiveService = new ObjectiveApplicationService({ store });
    const mockLLM = async () => ({ tool: "objective.create", args: { name: "LLM 识别的目标" } });
    const assistant = new AssistantService({ store, objectiveService, intentResolver: mockLLM });

    const result = await assistant.chat("随便说点什么");
    assert.equal(result.messages[1].data.objective.name, "LLM 识别的目标");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentResolver 失败回退规则版", async () => {
  const { store, directory } = await createStore();
  try {
    const objectiveService = new ObjectiveApplicationService({ store });
    const failingLLM = async () => {
      throw new Error("boom");
    };
    const assistant = new AssistantService({ store, objectiveService, intentResolver: failingLLM });

    const result = await assistant.chat("建目标 回退测试");
    assert.equal(result.messages[1].data.objective.name, "回退测试");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("createAssistantIntentResolver：无 openai 配置返回 null", () => {
  assert.equal(createAssistantIntentResolver({ provider: "disabled" }), null);
  assert.equal(createAssistantIntentResolver({ provider: "openai", openaiApiKey: "" }), null);
  assert.equal(createAssistantIntentResolver({ provider: "local-agent" }), null);
});
