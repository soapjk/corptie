import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationMessageContent,
  normalizeConversationMessage
} from "../src/application/conversationMessage.mjs";

test("plain text messages remain compatible", () => {
  assert.deepEqual(normalizeConversationMessage("  hello  "), { text: "hello", images: [] });
});

test("structured messages preserve validated one-turn Work and Session mentions", () => {
  assert.deepEqual(normalizeConversationMessage({
    text: "coordinate this",
    mentions: [
      { targetType: "work", targetId: "work:one", displayName: "Console" },
      { targetType: "session", targetId: "logical:two", displayName: "Reviewer" }
    ]
  }), {
    text: "coordinate this",
    images: [],
    mentions: [
      { targetType: "work", targetId: "work:one", displayName: "Console" },
      { targetType: "session", targetId: "logical:two", displayName: "Reviewer" }
    ]
  });
  assert.throws(
    () => normalizeConversationMessage({ text: "no", mentions: [{ targetType: "agent", targetId: "agent:one" }] }),
    { code: "INVALID_MESSAGE" }
  );
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
