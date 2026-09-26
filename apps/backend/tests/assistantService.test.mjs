import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
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

test("assistant.chat 建目标要求先选择 Contributor Agent", async () => {
  const { store, directory } = await createStore();
  try {
    const workService = new WorkApplicationService({ store });
    const assistant = new AssistantService({ store, workService });

    const result = await assistant.chat("建目标 重构 Corptie");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    const response = result.messages[1];
    assert.equal(response.role, "assistant");
    assert.match(response.content, /至少一个 Contributor Agent/);
    assert.deepEqual(store.listWorks(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistant.chat 建工作项在没有 Work 时要求先创建带 Contributor 的 Work", async () => {
  const { store, directory } = await createStore();
  try {
    const workService = new WorkApplicationService({ store });
    const assistant = new AssistantService({ store, workService });

    const result = await assistant.chat("建工作项 拆巨文件");
    const response = result.messages[1];
    assert.equal(response.role, "assistant");
    assert.match(response.content, /先新建 Work 并选择 Contributor Agent/);
    assert.deepEqual(store.listTasks(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistant.chat 查记忆 + 兜底回复", async () => {
  const { store, directory } = await createStore();
  try {
    const workService = new WorkApplicationService({ store });
    const assistant = new AssistantService({ store, workService });

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

test("intentResolver 注入：LLM 识别的 Work 创建仍遵守 Contributor 门禁", async () => {
  const { store, directory } = await createStore();
  try {
    const workService = new WorkApplicationService({ store });
    const mockLLM = async () => ({ tool: "work.create", args: { name: "LLM 识别的目标" } });
    const assistant = new AssistantService({ store, workService, intentResolver: mockLLM });

    const result = await assistant.chat("随便说点什么");
    assert.match(result.messages[1].content, /至少一个 Contributor Agent/);
    assert.deepEqual(store.listWorks(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentResolver 失败回退规则版仍遵守 Contributor 门禁", async () => {
  const { store, directory } = await createStore();
  try {
    const workService = new WorkApplicationService({ store });
    const failingLLM = async () => {
      throw new Error("boom");
    };
    const assistant = new AssistantService({ store, workService, intentResolver: failingLLM });

    const result = await assistant.chat("建目标 回退测试");
    assert.match(result.messages[1].content, /至少一个 Contributor Agent/);
    assert.deepEqual(store.listWorks(), []);
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
