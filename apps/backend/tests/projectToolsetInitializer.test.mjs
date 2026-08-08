import assert from "node:assert/strict";
import test from "node:test";
import { ProjectToolsetInitializer } from "../src/runtime/projectToolsetInitializer.mjs";

test("initializer skips a configured toolset during ordinary session creation", async () => {
  const calls = [];
  const initializer = new ProjectToolsetInitializer({
    manager: {
      async inspect() {
        return { repositoryId: "repository:one", configured: true };
      }
    },
    codexClient: {
      async startThread() {
        calls.push("startThread");
      }
    },
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url)
  });

  const result = await initializer.initialize("/repo");
  assert.equal(result.skipped, true);
  assert.deepEqual(calls, []);
});

test("initializer runs one isolated ephemeral Agent per repository", async () => {
  const calls = [];
  let configured = false;
  const manager = {
    async inspect() {
      return {
        repositoryId: "repository:one",
        configured,
        mainPath: "/repo",
        toolsetPath: "/repo/.corptie"
      };
    },
    async scaffold() {
      return {
        repositoryId: "repository:one",
        configured: false,
        mainPath: "/repo",
        toolsetPath: "/repo/.corptie"
      };
    }
  };
  const codexClient = {
    notifications: [],
    async startThread(options) {
      calls.push(["startThread", options]);
      return { thread: { id: "thread:init" } };
    },
    async startTurn(threadId, prompt, options) {
      calls.push(["startTurn", { threadId, prompt, options }]);
      configured = true;
      this.notifications.push({
        method: "turn/completed",
        params: { threadId, turn: { id: "turn:init", status: "completed" } }
      });
      return { turn: { id: "turn:init" } };
    },
    async readThread() {
      assert.fail("ephemeral initialization must not read turns");
    },
    async deleteThread(threadId) {
      calls.push(["deleteThread", { threadId }]);
    }
  };
  const initializer = new ProjectToolsetInitializer({
    manager,
    codexClient,
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url),
    runtimeOptions: async () => ({ model: "test-model", reasoningLevel: "medium" }),
    pollIntervalMs: 1
  });

  const [first, second] = await Promise.all([
    initializer.initialize("/repo"),
    initializer.initialize("/repo")
  ]);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(calls.filter(([name]) => name === "startThread").length, 1);
  const threadOptions = calls.find(([name]) => name === "startThread")[1];
  assert.equal(threadOptions.ephemeral, true);
  assert.deepEqual(threadOptions.runtimeWorkspaceRoots, ["/repo/.corptie"]);
  assert.equal(threadOptions.approvalPolicy, "never");
  const turnOptions = calls.find(([name]) => name === "startTurn")[1].options;
  assert.deepEqual(turnOptions.sandboxPolicy.writableRoots, ["/repo/.corptie"]);
  assert.equal(turnOptions.sandboxPolicy.networkAccess, false);
  assert.equal(calls.filter(([name]) => name === "deleteThread").length, 1);
});

test("a timed-out initializer interrupts and deletes its ephemeral Agent", async () => {
  const calls = [];
  const manager = {
    async inspect() {
      return {
        repositoryId: "repository:timeout",
        configured: false,
        mainPath: "/repo",
        toolsetPath: "/repo/.corptie"
      };
    },
    async scaffold() {
      return this.inspect();
    }
  };
  const codexClient = {
    notifications: [],
    async startThread() {
      return { thread: { id: "thread:timeout" } };
    },
    async startTurn() {
      return { turn: { id: "turn:timeout" } };
    },
    async interruptTurn(threadId, turnId) {
      calls.push(["interrupt", threadId, turnId]);
    },
    async deleteThread(threadId) {
      calls.push(["delete", threadId]);
    }
  };
  const initializer = new ProjectToolsetInitializer({
    manager,
    codexClient,
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url),
    timeoutMs: 5,
    pollIntervalMs: 1
  });

  await assert.rejects(() => initializer.initialize("/repo"), /Timed out/);
  assert.deepEqual(calls, [
    ["interrupt", "thread:timeout", "turn:timeout"],
    ["delete", "thread:timeout"]
  ]);
});

test("recovery retries an interrupted scaffold only once per backend process", async () => {
  const calls = [];
  const manager = {
    async inspect() {
      return {
        repositoryId: "repository:recovery",
        configured: false,
        mainPath: "/repo",
        toolsetPath: "/repo/.corptie"
      };
    },
    async scaffold() {
      throw new Error("interrupted initializer");
    }
  };
  const initializer = new ProjectToolsetInitializer({
    manager,
    codexClient: {},
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url),
    onEvent(type, payload) {
      calls.push([type, payload]);
    }
  });

  assert.equal(await initializer.recoverOnce("/repo"), true);
  assert.equal(await initializer.recoverOnce("/repo"), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(initializer.status("repository:recovery").state, "configurationFailed");
  assert.match(initializer.status("repository:recovery").error, /interrupted initializer/);
  assert.equal(calls.filter(([type]) => type === "ProjectToolsetInitializationFailed").length, 1);
});
