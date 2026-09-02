import assert from "node:assert/strict";
import test from "node:test";
import { LocalChoiceParserRuntime } from "../src/adapters/choiceParser.mjs";

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
