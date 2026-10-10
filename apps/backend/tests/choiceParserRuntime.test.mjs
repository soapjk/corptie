import assert from "node:assert/strict";
import test from "node:test";
import { LocalChoiceParserRuntime } from "../src/adapters/choiceParser.mjs";

test("local helper restarts with the selected Home when the default environment changes", async () => {
  const previousHome = process.env.CODEX_HOME;
  const homes = [];
  const runtime = new LocalChoiceParserRuntime({ createClient: options => {
    homes.push(options.env.CODEX_HOME);
    return { initialize: async () => {}, close: async () => {} };
  } });
  try {
    process.env.CODEX_HOME = "/tmp/isolated-test-home";
    runtime.configure({ provider: "local-agent", localCommand: "codex" }); await runtime.startPromise;
    process.env.CODEX_HOME = "/tmp/native-test-home";
    runtime.configure({ provider: "local-agent", localCommand: "codex" }); await runtime.startPromise;
    assert.deepEqual(homes, ["/tmp/isolated-test-home", "/tmp/native-test-home"]);
  } finally {
    runtime.stop("test-complete");
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});

test("detached local choice parser startup failure cannot terminate Backend", async () => {
  const initializationFailure = new Error("Codex app-server request timed out: initialize");
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const runtime = new LocalChoiceParserRuntime({
    createClient: () => ({
      initialize: async () => { throw initializationFailure; },
      close: async () => {}
    })
  });

  try {
    runtime.configure({ provider: "local-agent", localCommand: "codex" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(unhandled, []);
    assert.equal(runtime.ready, false);
    await assert.rejects(runtime.startPromise, initializationFailure);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    runtime.stop("test-complete");
  }
});
