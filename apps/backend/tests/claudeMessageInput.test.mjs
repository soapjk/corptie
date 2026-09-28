import test from "node:test";
import assert from "node:assert/strict";
import { makeClaudeUserMessage } from "../src/adapters/claudeMessageInput.mjs";

test("text input keeps the SDK user-message envelope", async () => {
  assert.deepEqual(await makeClaudeUserMessage("hello"), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
    parent_tool_use_id: null
  });
});

test("image format and missing resolved-path errors remain distinct", async () => {
  await assert.rejects(makeClaudeUserMessage("", [{ mimeType: "image/svg+xml" }]), {
    code: "CHAT_IMAGE_FORMAT_UNSUPPORTED"
  });
  await assert.rejects(makeClaudeUserMessage("", [{ mimeType: "IMAGE/PNG" }]), {
    code: "CHAT_IMAGE_MISSING"
  });
});
