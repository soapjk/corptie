import assert from "node:assert/strict";
import test from "node:test";
import { providerMessageWithSessionContext, userMessageWithoutSessionContext } from "../src/utils/sessionContextMessage.mjs";

test("Provider context wrappers preserve the visible user message across transcript replay", () => {
  const providerMessage = providerMessageWithSessionContext("Fix the bug", "Reference: architecture notes");
  assert.match(providerMessage, /^\[\[CORPTIE_CONTEXT_V1:/);
  assert.equal(userMessageWithoutSessionContext(providerMessage), "Fix the bug");
  assert.equal(userMessageWithoutSessionContext("Ordinary message"), "Ordinary message");
});
