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
    backgroundAgent: {
      async run() {
        calls.push("run");
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
  const backgroundAgent = {
    async run(input) {
      calls.push(input);
      configured = true;
      return { operationId: "background:init", providerId: "fake-writer" };
    }
  };
  const initializer = new ProjectToolsetInitializer({
    manager,
    backgroundAgent,
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url),
  });

  const [first, second] = await Promise.all([
    initializer.initialize("/repo"),
    initializer.initialize("/repo")
  ]);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "project-toolset-initialization");
  assert.equal(calls[0].permissionProfile, "workspace-write");
  assert.equal(calls[0].cwd, "/repo/.corptie");
  assert.deepEqual(calls[0].allowedRoots, ["/repo/.corptie"]);
  assert.match(calls[0].developerInstructions, /write only inside \/repo\/\.corptie/);
  assert.match(calls[0].prompt, /Project root \(read-only\): \/repo/);
  assert.equal(first.operationId, "background:init");
  assert.equal(first.providerId, "fake-writer");
});

test("initializer propagates background Agent failures without marking the toolset configured", async () => {
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
  const backgroundAgent = {
    async run(input) {
      assert.equal(input.timeoutMs, 5);
      throw new Error("background Agent timed out");
    }
  };
  const initializer = new ProjectToolsetInitializer({
    manager,
    backgroundAgent,
    referencePath: new URL("../resources/codex/skills/corptie-collaboration/references/project-tools-set.md", import.meta.url),
    timeoutMs: 5
  });

  await assert.rejects(() => initializer.initialize("/repo"), /background Agent timed out/);
  assert.equal((await manager.inspect()).configured, false);
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
    backgroundAgent: {},
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
