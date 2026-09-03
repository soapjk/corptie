import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationMessageContent,
  normalizeConversationMessage
} from "../src/application/conversationMessage.mjs";

test("plain text messages remain compatible", () => {
  assert.deepEqual(normalizeConversationMessage("  hello  "), { text: "hello", images: [] });
});

test("structured messages support image-only input and preserve both paths", () => {
  const input = normalizeConversationMessage({
    text: "",
    images: [{
      managedPath: "chat-resources/tasks/task_one/session_one/images/image.png",
      originalPath: "/Users/me/Desktop/image.png"
    }]
  });
  assert.equal(input.text, "");
  assert.deepEqual(conversationMessageContent(input), [{
    type: "image",
    managedPath: "chat-resources/tasks/task_one/session_one/images/image.png",
    originalPath: "/Users/me/Desktop/image.png"
  }]);
});

test("structured messages reject unmanaged image paths", () => {
  assert.throws(
    () => normalizeConversationMessage({ images: [{ managedPath: "../../outside.png" }] }),
    { code: "INVALID_MESSAGE" }
  );
});
